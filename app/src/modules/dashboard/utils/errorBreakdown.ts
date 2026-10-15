/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** How the errors of a run split: a response with an error status, or none at all. */
export interface ErrorBreakdown {
	httpErrors: number;
	noResponse: number;
}

/**
 * Read the engine's "HTTP errors" / "No response" split off a tick or a report
 * summary (issue #2124). The two sum to the failed total, so a source that
 * carries only the total and the no-response count (a tick stored by an older
 * engine) still yields the other half instead of a zero that would read as
 * "no HTTP errors".
 */
export function errorBreakdown(
	failed: number,
	httpErrors: number | undefined,
	noResponse: number | undefined
): ErrorBreakdown {
	const none = noResponse ?? 0;
	return { httpErrors: httpErrors ?? Math.max(0, failed - none), noResponse: none };
}
