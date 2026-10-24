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

import type { LoadTestMetrics, StatusSecondEntry } from "@/types";
import { coversSecond, secondPercentiles, worstReading } from "./tickPercentiles";

/**
 * The bucket the per-tick series transforms here round a tick's elapsed time to
 * before plotting. Shared so the "is there anything to plot" predicates below
 * bucket exactly as the transforms do - a second copy of `* 2) / 2` is how the
 * two would drift apart.
 */
function halfSecondBucket(elapsedSeconds: number): number {
	return Math.round(elapsedSeconds * 2) / 2;
}

/**
 * The status series' x value, which `hasStatusSeries` shares: every tick that
 * series reads closes a second ({@link closesStatusSecond}), so it is labelled
 * with the whole second it closes.
 */
function wholeSecondBucket(elapsedSeconds: number): number {
	return Math.round(elapsedSeconds);
}

/**
 * The ticks the status series diffs when no tick carries per-second counts (a
 * run stored before #2866): the ones that close one of the engine's
 * seconds (a stored tick, or the live gate frame stored as one) and carry a
 * status map. The 100 ms live frames between gates are left out, because the
 * count between two of them is the run's completions quantised to the frames
 * either side: a closed loop's batches land 4 to 6 to a window the frames make
 * 0.9 to 1.1 s wide (#2860). Between gates the window is the engine's own
 * second, so live and History draw the same points; it still runs a few ms
 * past 1 s, and an arrival in that overrun reads one batch high.
 */
function closesStatusSecond(m: LoadTestMetrics): boolean {
	return hasStatusCodes(m) && coversSecond(m);
}

/** A run is "rate limited" (can drop requests) only in constant_rps with a target. */
export function isRateLimitedRun(mode: string | undefined, targetRps: number | undefined): boolean {
	return mode === "constant_rps" && (targetRps ?? 0) > 0;
}

/** Responses per second of each status class over the interval a point closes. */
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
 * The latest a live head may land and still be the run's first frame. Past one
 * tick interval (with slack for a slow flush) the head has no predecessor in
 * the window - the live buffer was trimmed, or the stream attached late - so
 * its cumulative count is the run to date, not what one interval produced.
 */
const LIVE_HEAD_MAX_SECONDS = 1.5;

function isOrphanLiveHead(first: LoadTestMetrics | undefined): boolean {
	return Boolean(first?.live) && (first?.elapsed_seconds ?? 0) > LIVE_HEAD_MAX_SECONDS;
}

/** `value` as an entry, or null when it lacks an entry's shape (the rule the engine folds by). */
function statusSecondEntry(value: unknown): StatusSecondEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const { second, span, counts } = value as Partial<StatusSecondEntry>;
	const whole = (n: unknown, floor: number) => Number.isInteger(n) && (n as number) >= floor;
	if (!whole(second, 0) || !whole(span, 1)) return null;
	if (!Array.isArray(counts) || counts.length !== 5 || !counts.every((n) => whole(n, 0))) {
		return null;
	}
	return value as StatusSecondEntry;
}

const carriesStatusSeconds = (m: LoadTestMetrics): boolean => Array.isArray(m.status_seconds);

/** Every well-formed entry the series carries, in tick order; a malformed one is skipped. */
function* statusSecondEntries(history: LoadTestMetrics[]): Generator<StatusSecondEntry> {
	for (const m of history) {
		if (!Array.isArray(m.status_seconds)) continue;
		for (const raw of m.status_seconds) {
			const entry = statusSecondEntry(raw);
			if (entry) yield entry;
		}
	}
}

/**
 * Build per-second status-class rates for the status chart (#2866).
 *
 * The engine counts each response in the second it completed in and sends the
 * counts on every gate frame and stored row (`status_seconds`). When any tick
 * of the series carries them, they are drawn as counted: one point per entry,
 * each class' `counts / span` (so a downsampled bucket's entry, which spans its
 * whole bucket, is still responses per second, #2547), with no diff, no
 * division by elapsed time and no orphan head, because nothing is derived from
 * where the ticks happened to fall. A point sits at the end of its span in
 * load-start seconds, the clock live frames and stored rows both count
 * `elapsed_seconds` on (#2881), so it is where the other charts put that
 * instant. The live buffer can repeat a gate frame, so entries are kept once
 * per `second`.
 *
 * A series with no such tick is a run stored before #2866 and is read by
 * {@link buildStatusOverTimeFromCumulative}. The choice is per series, never
 * per tick: a run carries the key on every gate from its first row, and
 * diffing the ticks without it beside the entries of those with it would count
 * the same responses twice.
 *
 * The engine closes a second 250 ms after it ends and reports it at the next
 * gate, so a point arrives up to about 1.4 s after the instant it describes,
 * and the last partial second of a run is never closed, so it draws no point.
 * Seconds that close after the last stored row reach the live chart only.
 */
export function buildStatusOverTime(history: LoadTestMetrics[]): StatusPoint[] {
	if (!history.some(carriesStatusSeconds)) return buildStatusOverTimeFromCumulative(history);
	const bySecond = new Map<number, StatusSecondEntry>();
	for (const entry of statusSecondEntries(history)) bySecond.set(entry.second, entry);
	return Array.from(bySecond.values())
		.sort((a, b) => a.second - b.second)
		.map(({ second, span, counts: [c2, c3, c4, c5, cErr] }) => ({
			time: second + span,
			c2xx: c2 / span,
			c3xx: c3 / span,
			c4xx: c4 / span,
			c5xx: c5 / span,
			cErr: cErr / span,
		}));
}

/**
 * The fallback for a run stored before #2866: per-second status-class rates
 * diffed from the cumulative `status_codes` map each tick that closes a second
 * ({@link closesStatusSecond}) carries. Labels each on
 * its whole second (the last tick in a second standing for it), diffs
 * consecutive ones so a 5xx burst shows up as a band, not a slope change, and
 * divides each diff by the elapsed time between the two ticks. Diffs are
 * clamped >= 0 (the source is monotonic). Returns [] when no such tick exists.
 * A live second still open at the edge of the window has no gate yet, so it
 * draws no point until it closes.
 *
 * A live head past `LIVE_HEAD_MAX_SECONDS` has nothing to diff against, so it
 * seeds the baseline and draws no point of its own; the series starts at the
 * next bucket.
 *
 * The division is what keeps one unit across sources (#2547): a live gate
 * and a stored tick close about a second each, and a downsampled point
 * `ticksPerBucket` seconds, which a raw count would draw that many times
 * taller.
 */
function buildStatusOverTimeFromCumulative(history: LoadTestMetrics[]): StatusPoint[] {
	const byBucket = new Map<number, ClassSums & { time: number; elapsed: number }>();
	let first: LoadTestMetrics | undefined;
	for (const m of history) {
		if (!closesStatusSecond(m)) continue;
		first ??= m;
		const t = wholeSecondBucket(m.elapsed_seconds);
		byBucket.set(t, {
			time: t,
			elapsed: m.elapsed_seconds,
			...classifyCumulative(m.status_codes),
		});
	}
	const cum = Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
	const out: StatusPoint[] = [];
	// Live and stored series both count from load start (#2881), so the first
	// point closes the interval from 0.
	let prev: ClassSums & { elapsed: number } = {
		c2: 0,
		c3: 0,
		c4: 0,
		c5: 0,
		cErr: 0,
		elapsed: 0,
	};
	const orphanHead = isOrphanLiveHead(first) ? cum.shift() : undefined;
	if (orphanHead) prev = orphanHead;
	for (const c of cum) {
		const seconds = c.elapsed - prev.elapsed;
		// A head at elapsed 0 closes no time: a live frame stamped at load start,
		// before anything completed, or the first row of a raw run stored before
		// #2881. Either count stands as one second's rather than divide by 0.
		// A pre-#2881 run served downsampled has no such head: its first folded
		// bucket spans N-1 intervals, so that one point reads about 1/N high.
		// Accepted, because old rows are not corrected.
		const rate = (now: number, before: number) =>
			Math.max(0, now - before) / (seconds > 0 ? seconds : 1);
		out.push({
			time: c.time,
			c2xx: rate(c.c2, prev.c2),
			c3xx: rate(c.c3, prev.c3),
			c4xx: rate(c.c4, prev.c4),
			c5xx: rate(c.c5, prev.c5),
			cErr: rate(c.cErr, prev.cErr),
		});
		prev = c;
	}
	return out;
}

/**
 * The status chart's two views of the same per-second rates: `own` is each
 * class' rate over the interval a point closes (what a tooltip reports),
 * `stacked` is the running total up the stack (what the chart plots, so each
 * class' band fills between consecutive lines). Both run bottom to top: 2xx,
 * 3xx, 4xx, 5xx, err.
 */
export interface StatusStack {
	times: number[];
	own: number[][];
	stacked: number[][];
}

export function stackStatusPoints(points: StatusPoint[]): StatusStack {
	const own = [
		points.map((p) => p.c2xx),
		points.map((p) => p.c3xx),
		points.map((p) => p.c4xx),
		points.map((p) => p.c5xx),
		points.map((p) => p.cErr),
	];
	const running = points.map(() => 0);
	const stacked = own.map((band) => band.map((n, i) => (running[i] += n)));
	return { times: points.map((p) => p.time), own, stacked };
}

/**
 * Latest instantaneous receive rate in bytes per second, derived by diffing the
 * last two cumulative `bytes_received` samples (mirrors how currentRps is
 * derived). Returns 0 when there aren't two samples or no byte data.
 */
export function latestReceiveBytesPerSecond(history: LoadTestMetrics[]): number {
	if (history.length < 2) return 0;
	const a = history[history.length - 2];
	const b = history[history.length - 1];
	const dBytes = (b.bytes_received ?? 0) - (a.bytes_received ?? 0);
	const dt = b.elapsed_seconds - a.elapsed_seconds;
	if (dt <= 0 || dBytes <= 0) return 0;
	return dBytes / dt;
}

export interface LatencyPoint {
	time: number; // elapsed seconds, bucketed to 0.5s
	latencyMs: number; // perceived (window_avg_latency_ms)
	wireMs: number; // latency - queue_wait, clamped >= 0
	queueWaitMs: number; // generator-side overhead
}

/**
 * Whether a tick holds a window mean latency to plot: `null` is a window in
 * which nothing completed, absent is a tick stored before the window existed.
 * Neither is a 0 ms answer, and neither may borrow the run-cumulative
 * `avg_latency_ms`, which is the quantity the window exists to replace (#2393).
 */
export function hasWindowLatency(
	m: LoadTestMetrics
): m is LoadTestMetrics & { window_avg_latency_ms: number } {
	return typeof m.window_avg_latency_ms === "number";
}

/**
 * Bucket per-tick window means to 0.5s and split into wire + queue-wait.
 *
 * Only a tick that {@link hasWindowLatency} contributes a point: an idle window
 * adds nothing, and a run stored before the window existed yields no points
 * rather than a cumulative line under a per-tick label.
 */
export function buildLatencyChartData(history: LoadTestMetrics[]): LatencyPoint[] {
	const byBucket = new Map<number, LatencyPoint>();
	for (const m of history) {
		if (!hasWindowLatency(m)) continue;
		const t = halfSecondBucket(m.elapsed_seconds);
		const latency = m.window_avg_latency_ms;
		// The engine sets both means from one window, so a missing queue-wait mean
		// beside a latency one is read as no wait.
		const queue = m.window_avg_queue_wait_ms ?? 0;
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

/** One bucket of the percentile chart; `null` percentiles are an empty second. */
export interface PercentilePoint {
	time: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
}

/**
 * Bucket per-second latency percentiles to 0.5s.
 *
 * Only a tick that stands for a whole second contributes a point
 * ({@link coversSecond}): a live frame between gates carries a ~100 ms window
 * and adds nothing, so the live series has one point a second like the stored
 * one. A second with no completion is a `null` point, which uPlot draws as a
 * break in the line (issue #2386); skipping it instead would join its
 * neighbours straight across the stall. Ticks sharing a bucket keep the worst
 * reading of each percentile ({@link worstReading}) - the final frame closing
 * a partial second can land beside the last gate - and never an average, which
 * would hide the stall the percentile exists to show.
 */
export function buildPercentileChartData(history: LoadTestMetrics[]): PercentilePoint[] {
	const byBucket = new Map<number, PercentilePoint>();
	for (const m of history) {
		if (!coversSecond(m)) continue;
		const second = secondPercentiles(m);
		const t = halfSecondBucket(m.elapsed_seconds);
		const prev = byBucket.get(t);
		byBucket.set(t, {
			time: t,
			p50: worstReading(prev?.p50 ?? null, second?.p50 ?? null),
			p95: worstReading(prev?.p95 ?? null, second?.p95 ?? null),
			p99: worstReading(prev?.p99 ?? null, second?.p99 ?? null),
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

/** A tick carrying the cumulative status map the fallback of `buildStatusOverTime` diffs. */
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
 * bucket, last tick in the bucket wins - the bucketing the other per-tick
 * (non-cumulative) series here use.
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
 * `buildLatencyChartData` ignores ticks with no window latency. The status
 * series buckets differently and has its own gate, {@link hasStatusSeries}.
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
 * Whether `buildStatusOverTime` would return more than one point, answered
 * without building it: the status card's gate. With per-second counts
 * (#2866) that is two distinct seconds among the entries; otherwise distinct
 * whole-second buckets among the ticks the fallback reads
 * ({@link closesStatusSecond}), one more of them when its head is dropped.
 */
export function hasStatusSeries(history: LoadTestMetrics[]): boolean {
	if (history.some(carriesStatusSeconds)) return hasTwoStatusSeconds(history);
	const first = history.find(closesStatusSecond);
	const needed = isOrphanLiveHead(first) ? 3 : 2;
	const buckets = new Set<number>();
	for (const m of history) {
		if (!closesStatusSecond(m)) continue;
		buckets.add(wholeSecondBucket(m.elapsed_seconds));
		if (buckets.size >= needed) return true;
	}
	return false;
}

function hasTwoStatusSeconds(history: LoadTestMetrics[]): boolean {
	const seconds = new Set<number>();
	for (const entry of statusSecondEntries(history)) {
		seconds.add(entry.second);
		if (seconds.size >= 2) return true;
	}
	return false;
}

/**
 * True when any tick reports a whole-second p99 above zero - the "is there
 * latency to show" half of the percentile card's gate, read off the ticks
 * rather than off a built series.
 *
 * Exact against {@link buildPercentileChartData}: it plots the same ticks and a
 * bucket keeps the worst of its ticks, so a bucket reads above zero if and only
 * if one of its ticks does. The chart's own two-point guard still decides
 * whether anything is drawn.
 */
export function hasPercentileSignal(history: LoadTestMetrics[]): boolean {
	return history.some((m) => (secondPercentiles(m)?.p99 ?? 0) > 0);
}
