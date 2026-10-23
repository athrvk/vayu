/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestMetrics } from "@/types";

/**
 * What the Send / Throughput card's chip says about the gap between the rate
 * requests went out and the rate responses came back:
 * - `settling`: not enough run to tell yet (a gap that is open but has not
 *   lasted, or responses that have not had time to trail the sends);
 * - `kept-pace`: the two rates agree within {@link LagTolerance};
 * - `lagging`: the gap is open and has stayed open.
 */
export type DispatchStatus = "settling" | "kept-pace" | "lagging";

/** A gap counts only when it clears both bounds, so noise at a high rate and a rounding gap at a low one are neither. */
export interface LagTolerance {
	/** Smallest gap, req/s. */
	minGapRps: number;
	/** Smallest gap as a share of the send rate (0.1 = 10%). */
	minGapShare: number;
}

export const LAG_TOLERANCE: LagTolerance = { minGapRps: 1, minGapShare: 0.1 };

/** How long the windowed gap must stay open before the chip turns red. */
export const LAG_HOLD_SECONDS = 3;

/**
 * A windowed rate needs its first full second, and a response trails its
 * request by one latency, so no earlier reading says anything about the server.
 */
export const MIN_SETTLE_SECONDS = 1;

/** Whether `sendRate` outruns `receivedRate` by more than the tolerance. */
export function isGapOpen(
	sendRate: number,
	receivedRate: number,
	tolerance: LagTolerance = LAG_TOLERANCE
): boolean {
	const gap = sendRate - receivedRate;
	return gap >= tolerance.minGapRps && gap >= tolerance.minGapShare * sendRate;
}

/**
 * Whether the run has lasted long enough for responses to have caught up with
 * the sends. Completions trail dispatches by the mean latency, so a run younger
 * than that has an open gap even on a healthy server: 500 req/s against a
 * 100 ms target always has ~50 requests in flight. `meanLatencyMs` is 0 until a
 * response has landed, which is not settled either.
 */
export function isSettled(elapsedSeconds: number, meanLatencyMs: number): boolean {
	if (!(meanLatencyMs > 0)) return false;
	return elapsedSeconds >= Math.max(MIN_SETTLE_SECONDS, meanLatencyMs / 1000);
}

/**
 * The tick's own windowed gap, `undefined` for a tick carrying no windowed send
 * rate (the key is absent on a placeholder frame and on a tick stored before the
 * window existed; the run-cumulative `send_rate` must not stand in for it).
 */
export function windowedGapOpen(m: LoadTestMetrics): boolean | undefined {
	if (m.current_send_rate === undefined) return undefined;
	return isGapOpen(m.current_send_rate, m.current_rps);
}

/**
 * Fold one tick into the streak: the `elapsed_seconds` at which the windowed
 * gap opened, `null` while it is closed or unreadable. The store keeps one
 * number and applies this to each new tick, so "held" survives retention
 * trimming and costs nothing per render.
 */
export function foldLagStreak(since: number | null, m: LoadTestMetrics): number | null {
	if (!windowedGapOpen(m)) return null;
	return since ?? m.elapsed_seconds;
}

/** Whether a streak that began at `since` has lasted {@link LAG_HOLD_SECONDS} by `elapsedSeconds`. */
export function isHeld(since: number | null, elapsedSeconds: number): boolean {
	return since !== null && elapsedSeconds - since >= LAG_HOLD_SECONDS;
}

/**
 * The chip's verdict from two rates. The caller says which rates and how much
 * context backs them: a live run feeds the windowed pair with `held` and
 * `settled` read from the run's clock, History feeds the finished run's
 * cumulative pair with both true because nothing is still in flight.
 * `undefined` when either rate is missing, so the card draws no chip.
 */
export function dispatchStatus(input: {
	sendRate?: number;
	receivedRate?: number;
	held: boolean;
	settled: boolean;
	tolerance?: LagTolerance;
}): DispatchStatus | undefined {
	const { sendRate, receivedRate, held, settled, tolerance } = input;
	if (sendRate === undefined || receivedRate === undefined) return undefined;
	if (!settled) return "settling";
	if (!isGapOpen(sendRate, receivedRate, tolerance)) return "kept-pace";
	return held ? "lagging" : "settling";
}

/**
 * The live chip: the latest tick's windowed pair, judged against the streak the
 * store has been folding. `undefined` for a tick with no windowed send rate.
 */
export function liveDispatchStatus(
	m: Pick<LoadTestMetrics, "current_send_rate" | "current_rps" | "avg_latency_ms">,
	elapsedSeconds: number,
	lagSinceSeconds: number | null
): DispatchStatus | undefined {
	return dispatchStatus({
		sendRate: m.current_send_rate,
		receivedRate: m.current_rps,
		held: isHeld(lagSinceSeconds, elapsedSeconds),
		settled: isSettled(elapsedSeconds, m.avg_latency_ms),
	});
}
