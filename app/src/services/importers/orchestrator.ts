/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	ImportApplyCollection,
	ImportApplyEnvironment,
	ImportApplyRequest,
	ImportApplyRequestItem,
	ImportApplyResponse,
} from "@/types";
import type { CollectionDraft, ImportOptions, ImportResult } from "./types";

/** The subset of the API the orchestrator needs. Injected so it is easy to fake in tests. */
export interface ImportApi {
	applyImport(payload: ImportApplyRequest): Promise<ImportApplyResponse>;
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
 */
export class ImportOrchestrator {
	constructor(private readonly api: ImportApi) {}

	/** Drafts must already carry temp ids (see assignTempIds). */
	async run(result: ImportResult, opts: ImportOptions): Promise<void> {
		const collections: ImportApplyCollection[] = [];
		const requests: ImportApplyRequestItem[] = [];

		// Note: opts.importScripts is applied at PARSE time by the parsers (they emit empty scripts
		// when false). The orchestrator only needs importEnvironments.
		for (let i = 0; i < result.collections.length; i++) {
			flatten(result.collections[i], null, i, collections, requests);
		}

		const environments: ImportApplyEnvironment[] = opts.importEnvironments
			? result.environments.map((e) => ({
					tempId: requireTempId(e.tempId, "environment"),
					name: e.name,
					description: e.description,
					variables: e.variables,
				}))
			: [];

		const { idMap } = await this.api.applyImport({ collections, requests, environments });

		// The id-map is the endpoint's contract, so check it rather than assume it:
		// an item the engine silently skipped would otherwise look like a clean
		// import until the user noticed something missing. Nothing else consumes
		// the real ids today - the mutation invalidates the collection, request and
		// environment queries, which refetch them.
		const missing = [...collections, ...requests, ...environments]
			.map((item) => item.tempId)
			.filter((tempId) => !idMap[tempId]);
		if (missing.length > 0) {
			throw new Error(
				`Import incomplete: the engine returned no id for ${missing.length} item(s) (${missing
					.slice(0, 5)
					.join(", ")})`
			);
		}
	}
}

/** Depth-first, parents before their requests before their children - the tree order the preview shows. */
function flatten(
	c: CollectionDraft,
	parentTempId: string | null,
	order: number,
	collections: ImportApplyCollection[],
	requests: ImportApplyRequestItem[]
): void {
	const tempId = requireTempId(c.tempId, "collection");
	collections.push({
		tempId,
		parentTempId,
		name: c.name,
		description: c.description,
		order,
		variables: c.variables,
		auth: c.auth,
		preRequestScript: c.preRequestScript,
		postRequestScript: c.postRequestScript,
	});

	for (let i = 0; i < c.requests.length; i++) {
		const r = c.requests[i];
		requests.push({
			tempId: requireTempId(r.tempId, "request"),
			collectionTempId: tempId,
			name: r.name,
			description: r.description,
			method: r.method,
			url: r.url,
			params: r.params,
			headers: r.headers,
			body: r.body,
			bodyType: r.body.mode, // engine never derives this
			auth: r.auth,
			preRequestScript: r.preRequestScript,
			postRequestScript: r.postRequestScript,
			order: i,
		});
	}

	for (let i = 0; i < c.children.length; i++) {
		flatten(c.children[i], tempId, i, collections, requests);
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
