/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestMetrics } from "@/types";
import { hasSecondPercentiles, secondPercentiles } from "./tickPercentiles";

/** Default SLO threshold (ms) at which p99 is considered to have degraded. */
export const DEFAULT_SLO_MS = 200;

/** Whose threshold a breakpoint was judged against. */
export type SloSource = "run" | "settings";

/**
 * Whose line `judgedMs` is. It is the run's when it equals the run's own p99
 * line (`runOwnSloMs` live, `runSloMs(report)` stored); the Settings threshold
 * is a client preference, so any other value is Settings'. A run with a p99
 * budget that is judged against a different Settings number is still "settings".
 */
export function sloSourceOf(judgedMs: number | null, runOwnMs: number | undefined): SloSource {
	return judgedMs !== null && judgedMs === runOwnMs ? "run" : "settings";
}

/**
 * The capacity breakpoint of a ramp_up or capacity run: the first per-tick
 * moment at which p99 latency crossed the SLO threshold, and the concurrency in
 * flight then.
 * Consumed by the Saturation hero card (A1), the Breakpoint stat (A2), and the
 * Response-time-vs-concurrency scatter's SLO line (A3) - one definition, three
 * call sites.
 */
export interface Breakpoint {
	crossed: boolean;
	/** Concurrency at the crossing tick; null if never crossed. */
	concurrency: number | null;
	/** Elapsed seconds at the crossing tick; null if never crossed. */
	timeSeconds: number | null;
	/** p99 (ms) observed at the crossing tick; null if never crossed. */
	p99Ms: number | null;
	/**
	 * The SLO (ms) the run was judged against, carried so "not crossed" can name
	 * the line it never crossed even after the setting has changed. Null where no
	 * threshold was in play (a report with no per-tick series).
	 */
	sloMs: number | null;
	/**
	 * Whose line `sloMs` is: the run's own (a capacity budget or a p99 budget) or
	 * the client's Settings threshold. Only the first is an "SLO" the run declared;
	 * a label for the second says "Settings", not "SLO" (#2939).
	 */
	sloSource: SloSource;
	/**
	 * The crossing tick is the first one that held a whole-second p99 reading, so
	 * nothing was observed under the SLO before it: the run began over the line
	 * and there was no crossing to mark. False when not crossed.
	 */
	atRunStart: boolean;
}

/** A breakpoint the SLO has not been crossed for (yet), judged against `sloMs`. */
export function notCrossed(sloMs: number | null, sloSource: SloSource): Breakpoint {
	return {
		crossed: false,
		concurrency: null,
		timeSeconds: null,
		p99Ms: null,
		sloMs,
		sloSource,
		atRunStart: false,
	};
}

/**
 * The crossed breakpoint `m` sets, or null when it does not cross `thresholdMs`.
 * Judged on the tick's whole-second p99 ({@link secondPercentiles}), so a live
 * frame between gates - a ~100 ms window - never latches a breakpoint a stored
 * run of the same load would not. `firstReading` is whether no earlier tick held
 * such a p99, which the caller knows and a single tick cannot.
 */
export function breakpointAt(
	m: LoadTestMetrics,
	thresholdMs: number,
	sloSource: SloSource,
	firstReading: boolean
): Breakpoint | null {
	const p99 = secondPercentiles(m)?.p99 ?? 0;
	if (p99 <= thresholdMs) return null;
	return {
		crossed: true,
		concurrency: m.current_concurrency,
		timeSeconds: m.elapsed_seconds,
		p99Ms: p99,
		sloMs: thresholdMs,
		sloSource,
		atRunStart: firstReading,
	};
}

/**
 * Scan per-tick history for the first tick whose p99 exceeds `thresholdMs`.
 * `runOwnMs` is the run's own p99 line, which decides the breakpoint's
 * `sloSource` (the value judged does not change). History is assumed
 * time-ordered (as it arrives over SSE). On a downsampled
 * series a point is a bucket, so `atRunStart` reads "the first bucket".
 */
export function computeBreakpoint(
	history: LoadTestMetrics[],
	thresholdMs: number = DEFAULT_SLO_MS,
	runOwnMs?: number
): Breakpoint {
	const sloSource = sloSourceOf(thresholdMs, runOwnMs);
	let seenReading = false;
	for (const m of history) {
		const crossed = breakpointAt(m, thresholdMs, sloSource, !seenReading);
		if (crossed) return crossed;
		seenReading ||= hasSecondPercentiles(m);
	}
	return notCrossed(thresholdMs, sloSource);
}
