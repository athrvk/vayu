/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pure data transforms for the load-test dashboard. Kept side-effect-free and
 * component-free so they can be unit-tested in isolation; the SVG/card
 * components are dumb consumers of these results.
 */

import type { LoadTestMetrics } from "@/types";

/**
 * The bucket every series transform here rounds a tick's elapsed time to before
 * plotting. Shared so the "is there anything to plot" predicates below bucket
 * exactly as the transforms do - a second copy of `* 2) / 2` is how the two
 * would drift apart.
 */
function halfSecondBucket(elapsedSeconds: number): number {
	return Math.round(elapsedSeconds * 2) / 2;
}

/** A run is "rate limited" (can drop requests) only in constant_rps with a target. */
export function isRateLimitedRun(mode: string | undefined, targetRps: number | undefined): boolean {
	return mode === "constant_rps" && (targetRps ?? 0) > 0;
}

/** Per-interval status-class counts at a point in time. */
export interface StatusPoint {
	time: number;
	c2xx: number;
	c3xx: number;
	c4xx: number;
	c5xx: number;
	cErr: number; // network/connection failures (status code 0)
}

interface ClassSums {
	c2: number;
	c3: number;
	c4: number;
	c5: number;
	cErr: number;
}

function classifyCumulative(codes: Record<string, number> | undefined): ClassSums {
	const s: ClassSums = { c2: 0, c3: 0, c4: 0, c5: 0, cErr: 0 };
	for (const [code, count] of Object.entries(codes ?? {})) {
		const n = Number(code);
		if (n >= 200 && n < 300) s.c2 += count;
		else if (n >= 300 && n < 400) s.c3 += count;
		else if (n >= 400 && n < 500) s.c4 += count;
		else if (n >= 500 && n < 600) s.c5 += count;
		else s.cErr += count; // 0 = connection/network error
	}
	return s;
}

/**
 * Build per-interval status-class counts from the cumulative `status_codes`
 * map each tick carries. Buckets to 0.5s, then diffs consecutive buckets so the
 * stacked chart shows how many of each class arrived in each interval - a 5xx
 * burst shows up as a band, not a slope change. Diffs are clamped >= 0 (the
 * source is monotonic). Returns [] when no tick carries a status map.
 */
export function buildStatusOverTime(history: LoadTestMetrics[]): StatusPoint[] {
	const byBucket = new Map<number, ClassSums & { time: number }>();
	for (const m of history) {
		if (!m.status_codes) continue;
		const t = halfSecondBucket(m.elapsed_seconds);
		byBucket.set(t, { time: t, ...classifyCumulative(m.status_codes) });
	}
	const cum = Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
	const out: StatusPoint[] = [];
	let prev: ClassSums = { c2: 0, c3: 0, c4: 0, c5: 0, cErr: 0 };
	for (const c of cum) {
		out.push({
			time: c.time,
			c2xx: Math.max(0, c.c2 - prev.c2),
			c3xx: Math.max(0, c.c3 - prev.c3),
			c4xx: Math.max(0, c.c4 - prev.c4),
			c5xx: Math.max(0, c.c5 - prev.c5),
			cErr: Math.max(0, c.cErr - prev.cErr),
		});
		prev = c;
	}
	return out;
}

/**
 * Latest instantaneous receive throughput in MB/s, derived by diffing the last
 * two cumulative `bytes_received` samples (mirrors how currentRps is derived).
 * Returns 0 when there aren't two samples or no byte data.
 */
export function latestThroughputMbps(history: LoadTestMetrics[]): number {
	if (history.length < 2) return 0;
	const a = history[history.length - 2];
	const b = history[history.length - 1];
	const dBytes = (b.bytes_received ?? 0) - (a.bytes_received ?? 0);
	const dt = b.elapsed_seconds - a.elapsed_seconds;
	if (dt <= 0 || dBytes <= 0) return 0;
	return dBytes / dt / 1e6;
}

export interface LatencyPoint {
	time: number; // elapsed seconds, bucketed to 0.5s
	latencyMs: number; // perceived (avg_latency_ms)
	wireMs: number; // latency - queue_wait, clamped >= 0
	queueWaitMs: number; // generator-side overhead
}

/** Bucket per-tick latency to 0.5s and split into wire + queue-wait. */
export function buildLatencyChartData(history: LoadTestMetrics[]): LatencyPoint[] {
	const byBucket = new Map<number, LatencyPoint>();
	for (const m of history) {
		const t = halfSecondBucket(m.elapsed_seconds);
		const latency = m.avg_latency_ms ?? 0;
		const queue = m.avg_queue_wait_ms ?? 0;
		// Clamp wire >= 0 so wire <= latency always holds; this keeps the
		// amber gap path (latency over wire) non-self-intersecting downstream.
		const wire = Math.max(0, latency - queue);
		byBucket.set(t, { time: t, latencyMs: latency, wireMs: wire, queueWaitMs: queue });
	}
	return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
}

export interface RampPoint {
	time: number;
	configured: number;
	achieved: number;
}

export interface RampOverlay {
	points: RampPoint[];
	// Two-sided ramp deviation: mean of |achieved - configured| / target across
	// buckets, as a percentage. Computed app-side directly from the plotted
	// `configured` and `achieved` (= measured current_concurrency) series, so it
	// is consistent with the curves by construction. Unlike the retired
	// deficit-only "ramp lag", overshoot (achieved >> configured) is counted -
	// a 9x overshoot reads as a large deviation, not 0%. Denominator is `target`
	// (always > 0 here), so it never divides by zero even when configured == 0.
	rampDeviationPct: number;
	peakAchieved: number;
	target: number;
}

export interface RampParams {
	rampUpDurationSeconds?: number;
	startConcurrency?: number;
	targetConcurrency?: number;
}

export interface PercentilePoint {
	time: number;
	p50: number;
	p95: number;
	p99: number;
}

/** Bucket per-tick latency percentiles to 0.5s. */
export function buildPercentileChartData(history: LoadTestMetrics[]): PercentilePoint[] {
	const byBucket = new Map<number, PercentilePoint>();
	for (const m of history) {
		const t = halfSecondBucket(m.elapsed_seconds);
		byBucket.set(t, {
			time: t,
			p50: m.latency_p50_ms ?? 0,
			p95: m.latency_p95_ms ?? 0,
			p99: m.latency_p99_ms ?? 0,
		});
	}
	return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
}

/**
 * Build the configured-vs-achieved concurrency overlay for ramp_up runs.
 * Returns null when there's no target concurrency to ramp toward.
 */
export function buildRampOverlay(
	history: LoadTestMetrics[],
	params: RampParams
): RampOverlay | null {
	const target = params.targetConcurrency;
	if (!target || target <= 0) return null;

	const start = params.startConcurrency ?? 1;
	const rampSec = params.rampUpDurationSeconds ?? 0;

	const byBucket = new Map<number, RampPoint>();
	let peak = 0;
	for (const m of history) {
		const t = halfSecondBucket(m.elapsed_seconds);
		const achieved = m.current_concurrency ?? 0;
		if (achieved > peak) peak = achieved;
		const configured =
			rampSec > 0 && t < rampSec ? start + (target - start) * (t / rampSec) : target;
		byBucket.set(t, { time: t, configured, achieved });
	}
	const points = Array.from(byBucket.values()).sort((a, b) => a.time - b.time);

	// Two-sided deviation: mean of |achieved - configured| / target over buckets.
	// `target > 0` is guaranteed by the early return, so this is always finite.
	const rampDeviationPct =
		points.length > 0
			? (points.reduce((sum, p) => sum + Math.abs(p.achieved - p.configured), 0) /
					points.length /
					target) *
				100
			: 0;

	return {
		points,
		rampDeviationPct,
		peakAchieved: peak,
		target,
	};
}

/** A tick carrying the cumulative status map `buildStatusOverTime` reads. */
export const hasStatusCodes = (m: LoadTestMetrics): boolean => Boolean(m.status_codes);

/**
 * Custom trends, counters and rates over time - `metric.record` / `pm.metrics`
 * names a run declared, plotted on the run's own timeline (issue #1579).
 *
 * Modeled on {@link JoinedMonitorSeries} (`monitorSeries.ts`): a shared x column
 * plus one column per declared name. Unlike server vitals, there is nothing to
 * join here - `custom_metrics` already rides the same tick each name is read
 * from, the same situation `buildStatusOverTime` is in for `status_codes` - so
 * this reads directly off `history`, no resampling.
 */
export interface CustomMetricSeries {
	/** Elapsed seconds, one entry per bucket - the shared x column. */
	times: number[];
	/** Custom-metric names, sorted, in the order `columns`/`types` hold them. */
	names: string[];
	/** Each name's declared type, as first seen - trend, counter or rate. */
	types: ("trend" | "counter" | "rate")[];
	/** One column per name; `null` where no tick in that bucket recorded it. */
	columns: (number | null)[][];
}

const EMPTY_CUSTOM_METRICS: CustomMetricSeries = { times: [], names: [], types: [], columns: [] };

/** Every custom-metric name declared across `history`, sorted for stable series order/coloring. */
export function customMetricNames(history: LoadTestMetrics[]): string[] {
	const names = new Set<string>();
	for (const m of history) {
		for (const name of Object.keys(m.custom_metrics ?? {})) names.add(name);
	}
	return [...names].sort();
}

/** A tick carrying at least one custom metric. */
export const hasCustomMetrics = (m: LoadTestMetrics): boolean =>
	Boolean(m.custom_metrics && Object.keys(m.custom_metrics).length > 0);

/**
 * Build one representative value per declared custom-metric name per 0.5s
 * bucket, last tick in the bucket wins - the same bucketing
 * `buildPercentileChartData` uses for the other per-tick (non-cumulative)
 * numbers this engine reports.
 *
 * One value per name per tick, not one line per stat: a `trend` metric carries
 * up to four numbers (p50/p95/p99/max) and charting all of them would multiply
 * unpredictably against the 32-name cap - a run with 8 trend metrics would need
 * 32 lines on one chart. The representative is **p95 for a `trend`** (this
 * dashboard's other percentile-focused charts, e.g. `LatencyPercentilesChart`,
 * already treat p95 as the headline number) and **`value` for a `counter` or
 * `rate`** (the only number either type has).
 *
 * A tick whose `custom_metrics` map has no entry for a name yet is a gap
 * (`null`), not `0` - a run's other metrics may still be recording while this
 * one hasn't fired, and `0` would misrepresent "not recorded" as "recorded and
 * zero", the same distinction `joinMonitorToTimeline` draws for a stale
 * reading.
 */
export function buildCustomMetricsOverTime(history: LoadTestMetrics[]): CustomMetricSeries {
	const names = customMetricNames(history);
	if (names.length === 0) return EMPTY_CUSTOM_METRICS;

	const types: ("trend" | "counter" | "rate")[] = names.map(() => "counter");
	const typeSeen = new Array<boolean>(names.length).fill(false);
	const byBucket = new Map<number, (number | null)[]>();

	for (const m of history) {
		const t = halfSecondBucket(m.elapsed_seconds);
		const row = names.map((name, i) => {
			const metric = m.custom_metrics?.[name];
			if (!metric) return null;
			if (!typeSeen[i]) {
				types[i] = metric.type;
				typeSeen[i] = true;
			}
			const value = metric.type === "trend" ? metric.p95 : metric.value;
			return typeof value === "number" ? value : null;
		});
		byBucket.set(t, row);
	}

	const buckets = Array.from(byBucket.entries()).sort(([a], [b]) => a - b);
	const times = buckets.map(([t]) => t);
	const columns: (number | null)[][] = names.map((_, i) => buckets.map(([, row]) => row[i]));

	return { times, names, types, columns };
}

/**
 * The series label a chart shows for one declared custom-metric name.
 *
 * A trend's plotted line is not the metric itself but its p95 (see
 * {@link buildCustomMetricsOverTime}), so its label says so; a counter or rate
 * has only one number, so its name alone is unambiguous.
 */
export function customMetricSeriesLabel(name: string, type: "trend" | "counter" | "rate"): string {
	return type === "trend" ? `${name} (p95)` : name;
}

/**
 * True when `history` covers more than one 0.5s bucket - i.e. when the series
 * transforms above would return more than one point.
 *
 * The dashboard renders a chart card only when its series has something to
 * draw, and that question is a count, not a series: building the whole series
 * to read `.length` meant the transform ran twice per flush, once in the card's
 * gate and once inside the chart that actually plots it. This answers it
 * directly, allocating nothing and stopping at the first tick that lands in a
 * second bucket - two ticks, in the normal case.
 *
 * `include` narrows which ticks count, for a transform that skips some:
 * `buildStatusOverTime` ignores ticks with no `status_codes` map.
 */
export function spansMultipleBuckets(
	history: LoadTestMetrics[],
	include?: (m: LoadTestMetrics) => boolean
): boolean {
	let first: number | null = null;
	for (const m of history) {
		if (include && !include(m)) continue;
		const t = halfSecondBucket(m.elapsed_seconds);
		if (first === null) first = t;
		else if (t !== first) return true;
	}
	return false;
}

/**
 * True when any tick reports a p99 above zero - the "is there latency to show"
 * half of the percentile card's gate, read off the ticks rather than off a
 * built series.
 *
 * Deliberately not bucket-aware. `buildPercentileChartData` keeps the last tick
 * in each bucket, so a bucket whose final tick reported no completions reads 0
 * there while an earlier tick in it did not. This predicate can therefore only
 * be *more* permissive, and only while every such bucket is in that state - the
 * chart's own two-point guard still decides whether anything is drawn.
 */
export function hasPercentileSignal(history: LoadTestMetrics[]): boolean {
	return history.some((m) => (m.latency_p99_ms ?? 0) > 0);
}
