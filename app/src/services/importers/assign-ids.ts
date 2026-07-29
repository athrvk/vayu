/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { CollectionDraft, ImportResult } from "./types";

/**
 * Stamp every draft with a temp id before the import is sent.
 *
 * These are **opaque client strings**, not record ids: `POST /import/apply` uses
 * them only to let one item reference another (`parentTempId`,
 * `collectionTempId`) inside a payload whose real ids do not exist yet, and the
 * engine returns the temp-id -> real-id map it generated. They are never stored.
 *
 * This used to mint real `col_`/`req_`/`env_` UUIDs, because the orchestrator
 * created items one POST at a time and had to wire the tree together itself -
 * which is the only reason `POST /<resource>` ever accepted a client-supplied id
 * (issues #96, #97). Counters are enough now that the ids are per-call and
 * opaque, and they make a failing import name a readable item (`c3`, `r17`).
 *
 * Mutates the result in place (and returns it).
 */
export function assignTempIds(result: ImportResult): ImportResult {
	const next = { collection: 0, request: 0, environment: 0 };
	for (const c of result.collections) assignCollection(c, next);
	for (const e of result.environments) e.tempId = `e${++next.environment}`;
	return result;
}

type Counters = { collection: number; request: number; environment: number };

function assignCollection(c: CollectionDraft, next: Counters): void {
	c.tempId = `c${++next.collection}`;
	for (const r of c.requests) r.tempId = `r${++next.request}`;
	for (const child of c.children) assignCollection(child, next);
}
