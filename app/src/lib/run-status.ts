/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a stored run status says the engine is still executing the run.
 *
 * The engine answers `GET /runs/:id/report` for a live run too, so a report in
 * hand is not a finished run (#1925). A missing or unrecognised status is not
 * in progress: only the engine saying so keeps a report from being final.
 */
export function isRunInProgress(status: string | null | undefined): boolean {
	return status === "running" || status === "pending";
}
