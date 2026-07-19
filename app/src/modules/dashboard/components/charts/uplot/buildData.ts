/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bucketing helpers that turn `LoadTestMetrics[]` into uPlot aligned columns.
 * Every centralized time-series chart shares the same 0.5s bucketing so that
 * charts sharing a cursor line up tick-for-tick.
 */

import type { LoadTestMetrics } from "@/types";

const BUCKET = 0.5;
const bucketTime = (elapsed: number) => Math.round(elapsed / BUCKET) * BUCKET;

/** Bucket several fields at once; returns a shared time axis + one column each. */
export function bucketColumns(
	history: LoadTestMetrics[],
	picks: Array<(m: LoadTestMetrics) => number>
): { times: number[]; cols: number[][] } {
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

export const pickThroughput = (m: LoadTestMetrics): number => m.throughput ?? m.current_rps ?? 0;
export const pickSendRate = (m: LoadTestMetrics): number => m.send_rate ?? 0;
export const pickConcurrency = (m: LoadTestMetrics): number => m.current_concurrency ?? 0;
export const pickErrorRate = (m: LoadTestMetrics): number =>
	m.requests_completed > 0 ? ((m.requests_failed || 0) / m.requests_completed) * 100 : 0;
