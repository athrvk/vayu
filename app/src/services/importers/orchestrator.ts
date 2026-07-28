/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	Collection,
	Environment,
	GlobalVariables,
	Request,
	VariableValue,
	CreateCollectionRequest,
	CreateRequestRequest,
	CreateEnvironmentRequest,
} from "@/types";
import type { CollectionDraft, ImportOptions, ImportResult } from "./types";

/** The subset of the API the orchestrator needs. Injected so it is easy to fake in tests. */
export interface ImportApi {
	createCollection(data: CreateCollectionRequest & { id: string }): Promise<Collection>;
	createRequest(data: CreateRequestRequest & { id: string }): Promise<Request>;
	createEnvironment(data: CreateEnvironmentRequest & { id: string }): Promise<Environment>;
	deleteCollection(id: string): Promise<void>;
	deleteEnvironment(id: string): Promise<void>;
	getGlobals(): Promise<GlobalVariables>;
	updateGlobals(variables: Record<string, VariableValue>): Promise<GlobalVariables>;
}

export class ImportOrchestrator {
	private createdRootIds: string[] = [];
	private createdEnvIds: string[] = [];

	constructor(private readonly api: ImportApi) {}

	/** Drafts must already have IDs assigned (see assignIds). */
	async run(result: ImportResult, opts: ImportOptions): Promise<void> {
		if (result.collections.some((c) => !c.id) || result.environments.some((e) => !e.id)) {
			throw new Error("ImportOrchestrator.run: assignIds() must be called before run()");
		}
		// Note: opts.importScripts is applied at PARSE time by the parsers (they emit empty scripts
		// when false). The orchestrator only needs importEnvironments.
		try {
			for (let i = 0; i < result.collections.length; i++) {
				const root = result.collections[i];
				this.createdRootIds.push(root.id!); // track before recursing so rollback sees it if a child fails
				await this.createTree(root, undefined, i);
			}
			if (opts.importEnvironments) {
				for (const env of result.environments) {
					await this.api.createEnvironment({
						id: env.id!,
						name: env.name,
						description: env.description,
						variables: env.variables,
					});
					this.createdEnvIds.push(env.id!);
				}
			}
			// Globals last, and deliberately so: `POST /globals` **replaces** the whole
			// set, so it is the one write here that can destroy data the import did not
			// create. Running it after everything else means nothing can fail behind it,
			// so a failed import never leaves the user's globals half-rewritten and
			// rollback has no globals case to restore. Do not reorder without adding one.
			await this.applyGlobals(result, opts);
		} catch (err) {
			await this.rollback();
			throw err;
		}
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

	/** Create this collection, then its requests, then recurse into children. */
	private async createTree(
		c: CollectionDraft,
		parentId: string | undefined,
		order: number
	): Promise<void> {
		await this.api.createCollection({
			id: c.id!,
			name: c.name,
			description: c.description,
			parentId,
			order,
			variables: c.variables,
			auth: c.auth,
			preRequestScript: c.preRequestScript,
			postRequestScript: c.postRequestScript,
		});

		for (let i = 0; i < c.requests.length; i++) {
			const r = c.requests[i];
			await this.api.createRequest({
				id: r.id!,
				collectionId: c.id!,
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
			await this.createTree(c.children[i], c.id!, i);
		}
	}

	// Best-effort. Deleting a root cascades to its child collections + requests on the engine
	// (delete_collection BFS). This rollback's completeness depends on that engine cascade behavior.
	private async rollback(): Promise<void> {
		for (const id of this.createdRootIds) {
			try {
				await this.api.deleteCollection(id);
			} catch {
				/* best-effort: leave orphan rather than masking the original error */
			}
		}
		for (const id of this.createdEnvIds) {
			try {
				await this.api.deleteEnvironment(id);
			} catch {
				/* best-effort */
			}
		}
	}
}
