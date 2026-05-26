/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
  Collection,
  Environment,
  Request,
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
}

export class ImportOrchestrator {
  private createdRootIds: string[] = [];
  private createdEnvIds: string[] = [];

  constructor(private readonly api: ImportApi) {}

  /** Drafts must already have IDs assigned (see assignIds). */
  async run(result: ImportResult, opts: ImportOptions): Promise<void> {
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
    } catch (err) {
      await this.rollback();
      throw err;
    }
  }

  /** Create this collection, then its requests, then recurse into children. */
  private async createTree(c: CollectionDraft, parentId: string | undefined, order: number): Promise<void> {
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

  /** Best-effort: delete created roots (cascade wipes subtrees) + created envs. */
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
