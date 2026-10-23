/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestMetrics } from "@/types";
import { secondPercentiles } from "./tickPercentiles";

/**
 * The run's highest load so far and the worst whole-second p99 seen while at it.
 * `p99Ms` is `undefined` until a tick at that load held a whole-second reading.
 */
export interface PeakReading {
	peak: number;
	p99Ms: number | undefined;
}

export const NO_PEAK_READING: PeakReading = { peak: 0, p99Ms: undefined };

/**
 * Fold one tick into the running {@link PeakReading}. A tick above the peak
 * starts the reading over: a p99 seen at a lower load says nothing about the
 * new peak, and carrying it forward would let an early spike outvote the load
 * the stat is named for. Reads the same whole-second p99 as `computeBreakpoint`
 * ({@link secondPercentiles}), so a live frame between gates is no reading.
 */
export function foldPeakReading(acc: PeakReading, m: LoadTestMetrics): PeakReading {
	const p99 = secondPercentiles(m)?.p99;
	if (m.current_concurrency > acc.peak) return { peak: m.current_concurrency, p99Ms: p99 };
	if (m.current_concurrency < acc.peak || p99 === undefined) return acc;
	return { peak: acc.peak, p99Ms: Math.max(acc.p99Ms ?? p99, p99) };
}

/**
 * The p99 (ms) the run showed at its peak load: among the ticks whose
 * concurrency equals the run's peak, the largest whole-second p99. `undefined`
 * when no tick at the peak held one (a run with no per-tick series, or a peak
 * reached only on a tick with no completions); the caller falls back to the
 * run's cumulative p99. On a downsampled series a point is a bucket, whose
 * concurrency is its peak and whose p99 its worst second.
 */
export function p99AtPeak(history: readonly LoadTestMetrics[]): number | undefined {
	return history.reduce(foldPeakReading, NO_PEAK_READING).p99Ms;
}
