/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bucketing helpers that turn `LoadTestMetrics[]` into uPlot aligned columns.
 * Every centralized time-series chart shares the same bucket width (the user's
 * chart-granularity preference, 0.5s by default) so that charts sharing a
 * cursor line up tick-for-tick.
 */

import type { LoadTestMetrics } from "@/types";
import { DEFAULT_CHART_BUCKET_SECONDS } from "@/constants/client-settings";

/** Bucket several fields at once; returns a shared time axis + one column each. */
export function bucketColumns(
	history: LoadTestMetrics[],
	picks: Array<(m: LoadTestMetrics) => number>,
	bucketSeconds: number = DEFAULT_CHART_BUCKET_SECONDS
): { times: number[]; cols: number[][] } {
	const bucket = bucketSeconds > 0 ? bucketSeconds : DEFAULT_CHART_BUCKET_SECONDS;
	const bucketTime = (elapsed: number) => Math.round(elapsed / bucket) * bucket;
	const map = new Map<number, number[]>();
	for (const m of history) {
		const t = bucketTime(m.elapsed_seconds);
		map.set(
			t,
			picks.map((p) => p(m))
		);
	}
	const times = Array.from(map.keys()).sort((a, b) => a - b);
	const cols: number[][] = picks.map(() => []);
	for (const t of times) {
		const row = map.get(t)!;
		row.forEach((v, i) => cols[i].push(v));
	}
	return { times, cols };
}

/**
 * Re-bucket already-aligned `[times] + cols` to the given width (last sample in
 * a bucket wins, matching {@link bucketColumns}). Used by charts whose series are
 * built by per-tick transforms (latency/percentiles) so every shared-cursor chart
 * lines up at the same granularity.
 */
export function rebucket(
	times: number[],
	cols: number[][],
	bucketSeconds: number = DEFAULT_CHART_BUCKET_SECONDS
): { times: number[]; cols: number[][] } {
	const bucket = bucketSeconds > 0 ? bucketSeconds : DEFAULT_CHART_BUCKET_SECONDS;
	const bucketTime = (elapsed: number) => Math.round(elapsed / bucket) * bucket;
	const map = new Map<number, number[]>();
	for (let i = 0; i < times.length; i++) {
		map.set(
			bucketTime(times[i]),
			cols.map((c) => c[i])
		);
	}
	const outTimes = Array.from(map.keys()).sort((a, b) => a - b);
	const outCols: number[][] = cols.map(() => []);
	for (const t of outTimes) {
		const row = map.get(t)!;
		row.forEach((v, i) => outCols[i].push(v));
	}
	return { times: outTimes, cols: outCols };
}

export const pickThroughput = (m: LoadTestMetrics): number => m.throughput ?? m.current_rps ?? 0;
export const pickSendRate = (m: LoadTestMetrics): number => m.send_rate ?? 0;
export const pickConcurrency = (m: LoadTestMetrics): number => m.current_concurrency ?? 0;
export const pickErrorRate = (m: LoadTestMetrics): number =>
	m.requests_completed > 0 ? ((m.requests_failed || 0) / m.requests_completed) * 100 : 0;
