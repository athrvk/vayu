/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A stored series at the engine's one tick a second, and the engine's
 * `maxPoints` fold of it (#2547), for tests that hold what the History view
 * derives from a downsampled series to what it derives from the raw one.
 * Test-only.
 *
 * The fold restates `MetricTickBucket` (`engine/src/http/routes/metrics.cpp`):
 * consecutive runs of `ceil(total / maxPoints)` ticks, each the bucket's last
 * tick with the latency percentiles, `current_concurrency` and `backpressure`
 * replaced by the bucket's max and `current_rps` by its mean. A rule change
 * there is a change here too; `docs/engine/api-reference.md` ("Downsampling
 * with `maxPoints`") is the contract both follow.
 */

import type { LoadTestMetrics } from "@/types";
import type { TimeSeriesResponse } from "@/modules/history/types";

/** Completions a healthy second of {@link storedTicks} carries. */
export const STORED_RPS = 100;

/** The p99 a healthy second of {@link storedTicks} carries. */
export const STORED_P99_MS = 50;

/**
 * `seconds` stored ticks of a steady run: {@link STORED_RPS} completions a
 * second, all 200 unless `at` says otherwise, p99 {@link STORED_P99_MS}.
 * `at(second)` overrides that second's own figures; `failed` and `status` are
 * that second's own counts, which the series accumulates as the engine does.
 */
export function storedTicks(
	seconds: number,
	at: (second: number) => {
		p99?: number;
		failed?: number;
		status?: Record<string, number>;
	} = () => ({})
): LoadTestMetrics[] {
	const ticks: LoadTestMetrics[] = [];
	let completed = 0;
	let failed = 0;
	const codes: Record<string, number> = {};
	for (let s = 0; s < seconds; s++) {
		const own = at(s);
		completed += STORED_RPS;
		failed += own.failed ?? 0;
		for (const [code, n] of Object.entries(own.status ?? { "200": STORED_RPS })) {
			codes[code] = (codes[code] ?? 0) + n;
		}
		const p99 = own.p99 ?? STORED_P99_MS;
		ticks.push({
			timestamp: 1_750_000_000_000 + s * 1000,
			elapsed_seconds: s,
			requests_completed: completed,
			requests_failed: failed,
			current_rps: STORED_RPS,
			current_concurrency: 10,
			latency_p50_ms: p99 / 5,
			latency_p95_ms: p99 / 2,
			latency_p99_ms: p99,
			avg_latency_ms: p99 / 4,
			bytes_sent: 0,
			bytes_received: 0,
			status_codes: { ...codes },
		});
	}
	return ticks;
}

const MAX_KEYS = [
	"latency_p50_ms",
	"latency_p95_ms",
	"latency_p99_ms",
	"current_concurrency",
	"backpressure",
] as const;

function foldBucket(bucket: LoadTestMetrics[]): LoadTestMetrics {
	const folded: LoadTestMetrics = { ...bucket[bucket.length - 1] };
	for (const key of MAX_KEYS) {
		const values = bucket.map((m) => m[key]).filter((v): v is number => typeof v === "number");
		if (values.length > 0) folded[key] = Math.max(...values);
	}
	folded.current_rps = bucket.reduce((sum, m) => sum + m.current_rps, 0) / bucket.length;
	return folded;
}

/** The answer `GET /runs/:id/metrics?maxPoints=` gives for `ticks`. */
export function foldLikeEngine(ticks: LoadTestMetrics[], maxPoints: number): TimeSeriesResponse {
	const ticksPerBucket = Math.max(1, Math.ceil(ticks.length / maxPoints));
	const data: LoadTestMetrics[] = [];
	for (let i = 0; i < ticks.length; i += ticksPerBucket) {
		data.push(foldBucket(ticks.slice(i, i + ticksPerBucket)));
	}
	return {
		data,
		pagination: {
			total: ticks.length,
			limit: maxPoints,
			offset: 0,
			hasMore: false,
			returned: data.length,
		},
		bucketed: ticksPerBucket > 1,
		ticksPerBucket,
	};
}
