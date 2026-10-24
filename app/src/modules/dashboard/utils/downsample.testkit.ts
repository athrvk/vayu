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
 * replaced by the bucket's max and `current_rps` by its mean, and `status_seconds`
 * (#2866) by every entry of the bucket merged into one. A rule change
 * there is a change here too; `docs/engine/api-reference.md` ("Downsampling
 * with `maxPoints`") is the contract both follow. The monitor series' fold
 * (#2611, `foldLikeEngineMonitor`) restates the same engine file's
 * `MonitorSampleBucket`: the last sample's timestamp and each name's max.
 */

import type { LoadTestMetrics, MonitorSample, StatusSecondEntry } from "@/types";
import type { MonitorSeriesResponse, TimeSeriesResponse } from "@/modules/history/types";

/** Completions a healthy second of {@link storedTicks} carries. */
export const STORED_RPS = 100;

/** The p99 a healthy second of {@link storedTicks} carries. */
export const STORED_P99_MS = 50;

/** The index of a status code's class in an entry's `counts`: 2xx, 3xx, 4xx, 5xx, then the rest. */
function classIndex(code: string): number {
	const n = Number(code);
	return n >= 200 && n < 600 ? Math.floor(n / 100) - 2 : 4;
}

/**
 * `seconds` stored ticks of a steady run: {@link STORED_RPS} completions a
 * second, all 200 unless `at` says otherwise, p99 {@link STORED_P99_MS}.
 * `at(second)` overrides that second's own figures; `failed` and `status` are
 * that second's own counts, which the series accumulates as the engine does.
 * A tick is stored at the end of its second, counted from load start (#2881),
 * so the first sits at elapsed 1 and `second` is the tick's `elapsed_seconds`.
 *
 * With `statusSeconds`, each tick also carries what a stored gate row does
 * (#2866): the first holds `[]`, and tick `s` holds the one entry of second
 * `s - 1`, the second its gate closed, so the last second is never stored.
 */
export function storedTicks(
	seconds: number,
	at: (second: number) => {
		p99?: number;
		failed?: number;
		status?: Record<string, number>;
	} = () => ({}),
	options: { statusSeconds?: boolean } = {}
): LoadTestMetrics[] {
	const ticks: LoadTestMetrics[] = [];
	let completed = 0;
	let failed = 0;
	const codes: Record<string, number> = {};
	for (let s = 1; s <= seconds; s++) {
		const own = at(s);
		completed += STORED_RPS;
		failed += own.failed ?? 0;
		for (const [code, n] of Object.entries(own.status ?? { "200": STORED_RPS })) {
			codes[code] = (codes[code] ?? 0) + n;
		}
		const p99 = own.p99 ?? STORED_P99_MS;
		ticks.push({
			timestamp: 1_750_000_000_000 + (s - 1) * 1000,
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
			...(options.statusSeconds
				? { status_seconds: s > 0 ? [secondEntry(s - 1, at(s - 1).status)] : [] }
				: {}),
		});
	}
	return ticks;
}

function secondEntry(second: number, status: Record<string, number> = { "200": STORED_RPS }) {
	const counts: StatusSecondEntry["counts"] = [0, 0, 0, 0, 0];
	for (const [code, n] of Object.entries(status)) counts[classIndex(code)] += n;
	return { second, span: 1, counts };
}

const MAX_KEYS = [
	"latency_p50_ms",
	"latency_p95_ms",
	"latency_p99_ms",
	"current_concurrency",
	"backpressure",
] as const;

/** An entry the engine keeps when it folds: integer `second` >= 0 and `span` >= 1, five integer counts >= 0. */
function isEngineEntry(value: unknown): value is StatusSecondEntry {
	const whole = (n: unknown, floor: number) => Number.isInteger(n) && (n as number) >= floor;
	const e = value as Partial<StatusSecondEntry> | null;
	return (
		typeof e === "object" &&
		e !== null &&
		whole(e.second, 0) &&
		whole(e.span, 1) &&
		Array.isArray(e.counts) &&
		e.counts.length === 5 &&
		e.counts.every((n) => whole(n, 0))
	);
}

/**
 * `MetricTickBucket::add_status_seconds` and `take`: every entry of every tick
 * that carries the key, merged into the first entry with the spans and the
 * counts summed; `[]` when ticks carried the key but no valid entry; `undefined`
 * (key absent) when none did.
 */
function foldStatusSeconds(bucket: LoadTestMetrics[]): StatusSecondEntry[] | undefined {
	const carriers = bucket.filter((m) => Array.isArray(m.status_seconds));
	if (carriers.length === 0) return undefined;
	const entries = carriers.flatMap((m) => (m.status_seconds ?? []).filter(isEngineEntry));
	if (entries.length === 0) return [];
	const merged: StatusSecondEntry = {
		second: entries[0].second,
		span: 0,
		counts: [0, 0, 0, 0, 0],
	};
	for (const entry of entries) {
		merged.span += entry.span;
		entry.counts.forEach((n, i) => (merged.counts[i] += n));
	}
	return [merged];
}

function foldBucket(bucket: LoadTestMetrics[]): LoadTestMetrics {
	const folded: LoadTestMetrics = { ...bucket[bucket.length - 1] };
	for (const key of MAX_KEYS) {
		const values = bucket.map((m) => m[key]).filter((v): v is number => typeof v === "number");
		if (values.length > 0) folded[key] = Math.max(...values);
	}
	folded.current_rps = bucket.reduce((sum, m) => sum + m.current_rps, 0) / bucket.length;
	const statusSeconds = bucket.length > 1 ? foldStatusSeconds(bucket) : undefined;
	if (statusSeconds) folded.status_seconds = statusSeconds;
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

/** Wall-clock start of {@link storedTicks}, so a sample can sit on a tick. */
const FIRST_TICK_MS = 1_750_000_000_000;

/**
 * `count` scrapes `intervalMs` apart, the first on the first stored tick, each
 * carrying one gauge `cpu` that rises with its index.
 */
export function storedMonitorSamples(count: number, intervalMs: number): MonitorSample[] {
	return Array.from({ length: count }, (_, i) => ({
		timestamp: FIRST_TICK_MS + i * intervalMs,
		series: { cpu: i },
	}));
}

/** The answer `GET /runs/:id/monitor?maxPoints=` gives for `samples`. */
export function foldLikeEngineMonitor(
	samples: MonitorSample[],
	maxPoints: number
): MonitorSeriesResponse {
	const ticksPerBucket = Math.max(1, Math.ceil(samples.length / maxPoints));
	const data: MonitorSample[] = [];
	for (let i = 0; i < samples.length; i += ticksPerBucket) {
		const bucket = samples.slice(i, i + ticksPerBucket);
		const series: Record<string, number> = {};
		for (const sample of bucket) {
			for (const [name, value] of Object.entries(sample.series)) {
				series[name] = Math.max(series[name] ?? value, value);
			}
		}
		data.push({ timestamp: bucket[bucket.length - 1].timestamp, series });
	}
	return {
		data,
		pagination: {
			total: samples.length,
			limit: maxPoints,
			offset: 0,
			hasMore: false,
			returned: data.length,
		},
		bucketed: ticksPerBucket > 1,
		ticksPerBucket,
	};
}
