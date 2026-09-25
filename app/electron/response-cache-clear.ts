/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Recovers disk space from every engine response Chromium wrote to its HTTP
 * cache before the engine answered `Cache-Control: no-store` (issue #1507).
 *
 * The engine now stops new writes; this clears what an install upgrading from
 * an older engine already accumulated - measured at 1.2 GB on a 0.26.0 install
 * whose own database was 12 MB. Once per app version, the same shape
 * `appimage-stamp.ts` uses for its own one-time repair: read what was last
 * recorded, skip if it already matches, otherwise act and record.
 */

import { createJsonStore } from "./json-store.js";
import type { Session } from "electron";

// Read at `app.whenReady`; a corrupt file is an empty store, for the reason
// window-state.ts gives.
const store = createJsonStore<{ lastCacheClearVersion?: string }>("response-cache-clear");

/** Whether `version` has not yet had its one-time cache clear recorded. */
export function needsCacheClear(lastClearedVersion: string | undefined, version: string): boolean {
	return lastClearedVersion !== version;
}

/**
 * Clears `session`'s HTTP cache once per app version and records that it did.
 *
 * Never throws: a failed clear costs disk space, not correctness, and must
 * not interfere with startup. Left unrecorded on failure, so the next launch
 * retries rather than treating a version as cleared when it was not.
 */
export async function clearResponseCacheOnUpgrade(
	session: Pick<Session, "clearCache">,
	version: string
): Promise<boolean> {
	if (!needsCacheClear(store.get("lastCacheClearVersion"), version)) {
		return false;
	}
	try {
		await session.clearCache();
		store.set("lastCacheClearVersion", version);
		return true;
	} catch {
		return false;
	}
}
