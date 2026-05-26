/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { CollectionDraft, ImportResult } from "./types";

/**
 * Assign client-side unique IDs to every draft before any create call.
 * Eliminates the engine's now_ms() id-collision risk and lets parent references
 * (parentId / collectionId) resolve without server round-trips.
 *
 * Mutates the result in place (and returns it).
 */
export function assignIds(result: ImportResult): ImportResult {
  for (const c of result.collections) assignCollection(c);
  for (const e of result.environments) e.id = `env_${crypto.randomUUID()}`;
  return result;
}

function assignCollection(c: CollectionDraft): void {
  c.id = `col_${crypto.randomUUID()}`;
  for (const r of c.requests) r.id = `req_${crypto.randomUUID()}`;
  for (const child of c.children) assignCollection(child);
}
