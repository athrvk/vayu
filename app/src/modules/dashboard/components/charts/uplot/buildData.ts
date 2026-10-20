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
import { hasSecondPercentiles, secondPercentiles } from "../../../utils/tickPercentiles";

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

/** Which sample a bucket keeps when several ticks land in it. */
export type BucketMerge = "last" | "max";

/**
 * Re-bucket already-aligned `[times] + cols` to the given width. Used by charts
 * whose series are built by per-tick transforms (latency/percentiles) so every
 * shared-cursor chart lines up at the same granularity.
 *
 * `merge` says what a bucket keeps: the last sample, matching
 * {@link bucketColumns}, or the largest per column. A percentile series takes
 * `"max"`: a 5 s bucket holding five per-second p99s shows the worst second,
 * where "last" would hide a stall in the first four and an average of
 * percentiles is not a percentile of anything.
 */
export function rebucket(
	times: number[],
	cols: number[][],
	bucketSeconds: number = DEFAULT_CHART_BUCKET_SECONDS,
	merge: BucketMerge = "last"
): { times: number[]; cols: number[][] } {
	const bucket = bucketSeconds > 0 ? bucketSeconds : DEFAULT_CHART_BUCKET_SECONDS;
	const bucketTime = (elapsed: number) => Math.round(elapsed / bucket) * bucket;
	const map = new Map<number, number[]>();
	for (let i = 0; i < times.length; i++) {
		const t = bucketTime(times[i]);
		const row = cols.map((c) => c[i]);
		const prev = map.get(t);
		map.set(t, merge === "max" && prev ? row.map((v, k) => Math.max(prev[k], v)) : row);
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
/** The tick's whole-second p99, 0 where it holds none (the scatter drops those ticks first). */
export const pickLatencyP99 = (m: LoadTestMetrics): number => secondPercentiles(m)?.p99 ?? 0;
export const pickErrorRate = (m: LoadTestMetrics): number =>
	m.requests_completed > 0 ? ((m.requests_failed || 0) / m.requests_completed) * 100 : 0;

/**
 * (concurrency, p99) points for the response-time-vs-concurrency scatter,
 * bucketed to the shared chart width before they are sorted.
 *
 * The scatter used to map and sort every retained tick and hand uPlot one dot
 * per tick, while every other chart here collapses ticks into buckets first -
 * so a 5-minute window at the engine's 10Hz tick was ~3,000 dots redrawn on
 * every flush, and a full-run window up to the store's 50,000-tick cap. Its
 * per-flush cost is now the bucket count, like everything else on this canvas.
 *
 * Only ticks that hold a whole second's p99 are plotted ({@link secondPercentiles}):
 * a live frame between gates carries a ~100 ms window, which would put a
 * different quantity on the same axis as the stored run's dots.
 *
 * Last sample in a bucket wins (that is {@link bucketColumns}), which keeps the
 * elbow: the point a ramp step settles at is the one that survives, where an
 * average over the bucket would round the knee off. `times` carries each
 * point's bucket timestamp in the plotted order, so the focus channel still
 * maps a dot to a moment - and now to the same instant the time charts key on.
 */
export function buildConcurrencyScatter(
	history: LoadTestMetrics[],
	bucketSeconds: number = DEFAULT_CHART_BUCKET_SECONDS
): { concurrency: number[]; p99: number[]; times: number[] } {
	const { times, cols } = bucketColumns(
		history.filter(hasSecondPercentiles),
		[pickConcurrency, pickLatencyP99],
		bucketSeconds
	);
	// uPlot needs x ascending; concurrency rises over a ramp, but sort to be
	// safe. Sorting an index permutation keeps each bucket's (x, y, t) together.
	const order = times.map((_, i) => i).sort((a, b) => cols[0][a] - cols[0][b]);
	return {
		concurrency: order.map((i) => cols[0][i]),
		p99: order.map((i) => cols[1][i]),
		times: order.map((i) => times[i]),
	};
}
