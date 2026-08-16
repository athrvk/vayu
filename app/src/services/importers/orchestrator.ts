/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	GlobalVariables,
	VariableValue,
	ImportApplyCollection,
	ImportApplyEnvironment,
	ImportApplyRequest,
	ImportApplyRequestItem,
	ImportApplyResponse,
	ImportApplySpec,
} from "@/types";
import type { CollectionDraft, ImportOptions, ImportResult } from "./types";
import { requestFieldsFromDraft } from "./request-payload";

/** The subset of the API the orchestrator needs. Injected so it is easy to fake in tests. */
export interface ImportApi {
	applyImport(payload: ImportApplyRequest): Promise<ImportApplyResponse>;
	getGlobals(): Promise<GlobalVariables>;
	updateGlobals(variables: Record<string, VariableValue>): Promise<GlobalVariables>;
}

/**
 * Flattens a parsed import into the single `POST /import/apply` payload and
 * sends it.
 *
 * This used to walk the tree issuing one POST per collection, per request and
 * per environment - a 500-request import was ~500 sequential localhost round
 * trips - and, because any of them could fail halfway, it carried a best-effort
 * `rollback()` that deleted the roots it had already created. The engine call is
 * atomic now (issue #96), so both the loop and the rollback are gone: either the
 * whole tree lands or nothing does, and a failure is the engine's 400 naming the
 * item that broke.
 *
 * Globals are the one part that `/import/apply` does not carry: they are an
 * engine singleton behind `POST /globals`, not a tree item with a temp id, so
 * they stay a separate write - see `applyGlobals`.
 */
export class ImportOrchestrator {
	constructor(private readonly api: ImportApi) {}

	/**
	 * Drafts must already carry temp ids (see assignTempIds).
	 *
	 * Returns the engine's temp-id -> real-id map. It used to be checked and
	 * dropped; a spec-bound import needs it, because the collection the spec's
	 * file path is remembered under does not have an id until this call answers
	 * (issue #638).
	 */
	async run(result: ImportResult, opts: ImportOptions): Promise<Record<string, string>> {
		const collections: ImportApplyCollection[] = [];
		const requests: ImportApplyRequestItem[] = [];
		const specs: ImportApplySpec[] = [];

		// Note: opts.importScripts is applied at PARSE time by the parsers (they emit empty scripts
		// when false). The orchestrator only needs importEnvironments.
		/*
		 * Root collections state no `order`. They are joining a list that already
		 * has occupants, and the engine's create path appends after the stored
		 * roots (handing out consecutive slots from there for a bulk payload).
		 * Sending the payload index instead collided head-on with the existing
		 * roots' 0, 1, 2..., so an import into a non-empty workspace interleaved
		 * itself through the user's tree by tie lottery instead of landing at the
		 * end. Everything below a root keeps its explicit index - those parents
		 * are new in this payload, so there is nothing to collide with.
		 */
		for (const root of result.collections) {
			flatten(root, null, undefined, collections, requests, specs);
		}

		const environments: ImportApplyEnvironment[] = opts.importEnvironments
			? result.environments.map((e) => ({
					tempId: requireTempId(e.tempId, "environment"),
					name: e.name,
					description: e.description,
					variables: e.variables,
				}))
			: [];

		const { idMap } = await this.api.applyImport({
			collections,
			requests,
			environments,
			specs,
		});

		// The id-map is the endpoint's contract, so check it rather than assume it:
		// an item the engine silently skipped would otherwise look like a clean
		// import until the user noticed something missing. The caller reads the map
		// for the spec-bound roots; everything else is refetched by the mutation's
		// invalidations.
		const missing = [...collections, ...requests, ...environments, ...specs]
			.map((item) => item.tempId)
			.filter((tempId) => !idMap[tempId]);
		if (missing.length > 0) {
			throw new Error(
				`Import incomplete: the engine returned no id for ${missing.length} item(s) (${missing
					.slice(0, 5)
					.join(", ")})`
			);
		}

		// Globals last, and deliberately so: `POST /globals` **replaces** the whole
		// set, so it is the one write here that can destroy data the import did not
		// create. Running it after the apply - and after the id-map check above -
		// means nothing can fail behind it, so a failed import never leaves the
		// user's globals half-rewritten. Do not reorder.
		await this.applyGlobals(result, opts);

		return idMap;
	}

	/**
	 * Merge imported globals into the existing set. The engine has no merge verb -
	 * a POST replaces everything - so the union is computed here from a fresh read.
	 * Writing `result.globals` alone would silently delete every global the user
	 * already had.
	 *
	 * On a key collision the imported value wins: the user explicitly asked for this
	 * file's variables, and skipping them would be the silent no-op the issue calls
	 * the worst outcome. Documented in `docs/app/import-collections/postman-environment.md`.
	 */
	private async applyGlobals(result: ImportResult, opts: ImportOptions): Promise<void> {
		if (!opts.importEnvironments) return;
		// No read, no write - every other format lands here and must not touch the scope.
		if (Object.keys(result.globals).length === 0) return;
		const existing = await this.api.getGlobals();
		await this.api.updateGlobals({ ...existing.variables, ...result.globals });
	}
}

/**
 * Depth-first, parents before their requests before their children - the tree
 * order the preview shows.
 *
 * `order` is `undefined` for a root, which leaves the slot to the engine's
 * append path (see `run`). Spread rather than assigned, for the same reason the
 * redirect fields below are: "absent" is the state the engine's field appliers
 * read, and the payload is compared structurally in tests.
 */
function flatten(
	c: CollectionDraft,
	parentTempId: string | null,
	order: number | undefined,
	collections: ImportApplyCollection[],
	requests: ImportApplyRequestItem[],
	specs: ImportApplySpec[]
): void {
	const tempId = requireTempId(c.tempId, "collection");
	// The spec document, when this collection was parsed from one, as its own
	// payload section - it is a resource several collections may bind, not a
	// field of this one, so it gets a temp id the binding references (issue
	// #637). The binding is `specTempId`: the document has no engine id until
	// this same call mints one.
	const specTempId = c.spec ? requireTempId(c.spec.tempId, "spec") : undefined;
	if (c.spec && specTempId) {
		specs.push({
			tempId: specTempId,
			content: c.spec.content,
			...(c.spec.sourceUrl !== undefined ? { sourceUrl: c.spec.sourceUrl } : {}),
			// The declared-operation index the parser extracted (issue #629),
			// stored in the same atomic call as the document it describes.
			...(c.spec.operations && c.spec.operations.length > 0
				? { operations: c.spec.operations }
				: {}),
			// The response schema index (issue #628), on the same terms: stored
			// with the document it describes, in the same transaction.
			...(c.spec.responseSchemas ? { responseSchemas: c.spec.responseSchemas } : {}),
		});
	}
	collections.push({
		tempId,
		parentTempId,
		name: c.name,
		description: c.description,
		...(order !== undefined ? { order } : {}),
		variables: c.variables,
		auth: c.auth,
		preRequestScript: c.preRequestScript,
		postRequestScript: c.postRequestScript,
		...(specTempId ? { openapi: { specTempId } } : {}),
	});

	for (let i = 0; i < c.requests.length; i++) {
		const r = c.requests[i];
		requests.push({
			tempId: requireTempId(r.tempId, "request"),
			collectionTempId: tempId,
			// Every field that comes from the draft, shared with the OpenAPI sync
			// so a field added for one write path cannot go missing on the other.
			...requestFieldsFromDraft(r),
			order: i,
		});
	}

	for (let i = 0; i < c.children.length; i++) {
		flatten(c.children[i], tempId, i, collections, requests, specs);
	}
}

function requireTempId(tempId: string | undefined, kind: string): string {
	if (!tempId) {
		throw new Error(
			`ImportOrchestrator.run: assignTempIds() must be called before run() (${kind} has no tempId)`
		);
	}
	return tempId;
}
