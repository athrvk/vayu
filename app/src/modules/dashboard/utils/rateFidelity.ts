/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** What the Rate fidelity card shows: the send rate and its share of the target. */
export interface RateFidelity {
	/** Requests sent over the sending window so far, req/s. */
	actualRps: number;
	/** `requestsSent / (targetRps x window) x 100`; absent without a target. */
	achievementPct?: number;
}

/**
 * Rate fidelity for a run in progress (#2392): requests the generator has sent
 * against what the target owed it over the sending window, the same definition
 * the finished report states (`rateControl.achievement`). The window is the
 * elapsed time capped at the configured duration, because the engine stops
 * submitting at the deadline and then drains: past it, elapsed time keeps
 * growing while nothing more is owed.
 *
 * Reads the sent count rather than the tick's `requests_expected`, which is 0
 * for `constant_rps`. `undefined` before there is a window to divide by, so the
 * card draws its empty state instead of a 0 or a NaN.
 */
export function liveRateFidelity(input: {
	targetRps?: number;
	requestsSent?: number;
	elapsedSeconds: number;
	durationSeconds?: number;
}): RateFidelity | undefined {
	const { targetRps, requestsSent, elapsedSeconds, durationSeconds } = input;
	if (requestsSent === undefined) return undefined;

	const window =
		durationSeconds && durationSeconds > 0
			? Math.min(elapsedSeconds, durationSeconds)
			: elapsedSeconds;
	if (!(window > 0)) return undefined;

	const actualRps = requestsSent / window;
	if (!targetRps || targetRps <= 0) return { actualRps };
	return { actualRps, achievementPct: (requestsSent / (targetRps * window)) * 100 };
}
