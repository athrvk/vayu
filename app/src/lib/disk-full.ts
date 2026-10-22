/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { ApiError } from "@/services/http-client";

/** The engine's answer to a write the data folder's volume has no room for (#2423). */
const HTTP_INSUFFICIENT_STORAGE = 507;

/**
 * Whether a failed write was the engine's 507. Not a final error: it retries on
 * the autosave backoff like any 5xx, and the save reports `disk-full` so the
 * quit prompt can name the cause. Every save path that maps a rejection to a
 * `SaveOutcome` asks this, so a path that forgets it shows up as the quit
 * prompt blaming the engine for a full disk.
 */
export function isDiskFullError(error: unknown): boolean {
	return error instanceof ApiError && error.statusCode === HTTP_INSUFFICIENT_STORAGE;
}
