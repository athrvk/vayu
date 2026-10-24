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
	/** `requestsSent` over what the target owed, as a percentage; absent without a target. */
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
 * Owed-to-date is `targetRps x window`, not the tick's `requests_expected`:
 * that is the whole plan, so sent over it is progress through the run, not
 * fidelity to the rate. Once the window has reached the configured duration the
 * target owes the engine's whole count, `floor(targetRps x duration)`, because
 * the engine sends whole requests: 33.3 req/s for 3 s sends 99, not 99.9, and a
 * run that sent them all must read 100 (#2910). `undefined` before there is a
 * window to divide by, so the card draws its empty state instead of a 0 or a
 * NaN.
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
	const owed = owedOverWindow(targetRps, window, durationSeconds);
	return { actualRps, achievementPct: (requestsSent / owed) * 100 };
}

/**
 * Same slack as `requests_owed_by` in the engine's `load_pacing.hpp`: a decimal
 * rate and duration can multiply to a whole number that binary lands just below
 * (0.57 x 100 is 56.99999999999999), and the engine owes 57 there.
 */
const PRODUCT_SLACK = 8 * Number.EPSILON;

function owedOverWindow(targetRps: number, window: number, durationSeconds?: number): number {
	const continuous = targetRps * window;
	if (!durationSeconds || durationSeconds <= 0 || window < durationSeconds) return continuous;
	const wholeRequests = Math.floor(targetRps * durationSeconds * (1 + PRODUCT_SLACK));
	return wholeRequests > 0 ? wholeRequests : continuous;
}
