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

/** The statuses a run settles in: the engine will not move it again. */
export type TerminalRunStatus = "completed" | "stopped" | "failed";

/**
 * Whether a run status says the run has settled.
 *
 * Not the complement of {@link isRunInProgress}: a missing or unrecognised
 * status (an engine newer than this client) is neither in progress nor
 * terminal, so a caller that needs a decision has to ask the engine again.
 */
export function isRunTerminal(status: string | null | undefined): status is TerminalRunStatus {
	return status === "completed" || status === "stopped" || status === "failed";
}

/**
 * Whether a run is live, from its stored status and from whether a stream in
 * this window says so (`useRunLiveness` gathers the second).
 *
 * The stored status decides when it can: a terminal one is the engine's word
 * that the run is over, whatever a stream that has not caught up still says,
 * and an in-progress one keeps the run live through a lost stream. Only a
 * status not read yet, or one this client does not recognise, defers to the
 * stream.
 */
export function isRunLive(storedStatus: string | null | undefined, streamLive: boolean): boolean {
	if (isRunTerminal(storedStatus)) return false;
	return isRunInProgress(storedStatus) || streamLive;
}
