/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Anomaly detection over a run's per-tick series - the windows a cumulative
 * summary hides.
 *
 * A run's averages answer "how did it go overall"; they cannot answer "when did
 * it go wrong". A p99 that quadrupled for three seconds and recovered moves the
 * run's mean by almost nothing, so the only trace of it is a bump on a chart the
 * reader has to notice unaided. This scans the same per-tick series the charts
 * plot and *names* those windows, so the finding is stated rather than left to
 * be spotted.
 *
 * Deliberately dumb: fixed factors over a trailing median, a minimum run length,
 * and nothing tunable. A detector with knobs is a detector nobody trusts the
 * defaults of, and one with a model is a detector that flags different windows
 * on the same data twice. Every constant below is exported so the tests pin the
 * rule rather than restate it.
 *
 * Pure over `LoadTestMetrics[]`, like {@link computeBreakpoint} beside it: the
 * live dashboard and the history view both derive from their own series and pass
 * the result down, so no card re-derives from raw metrics.
 */

import type { LoadTestMetrics } from "@/types";

export type AnomalyKind = "latency_spike" | "error_burst" | "throughput_drop" | "first_5xx";

export interface Anomaly {
	kind: AnomalyKind;
	/** Elapsed seconds at the first affected tick. */
	startSeconds: number;
	/** Elapsed seconds at the last affected tick; equal to the start for a point. */
	endSeconds: number;
	/**
	 * How far past normal, as a multiple: 4.2 on a latency spike is "4.2x the
	 * baseline", on an error burst "4.2x the 1% burst threshold", on a throughput
	 * drop "throughput fell to 1/4.2 of baseline". Always >= 1 for a detection,
	 * and exactly 1 for a point event, which has no scale. One comparable number
	 * across kinds is what {@link MAX_ANOMALIES} ranks by.
	 */
	magnitude: number;
	/** The finding in words, e.g. "p99 4.2x baseline for 3s". */
	label: string;
}

/**
 * Ticks of history a baseline is taken over. The median (not the mean) of the
 * trailing window, so the two ticks that open a spike cannot drag the baseline
 * up to meet themselves.
 */
export const BASELINE_TICKS = 15;

/** p99 above this multiple of baseline is a spike. */
export const LATENCY_SPIKE_FACTOR = 3;

/**
 * A spike window stays open until p99 falls back under this multiple. Lower than
 * the opening factor on purpose: a recovery that stalls at 2x baseline is still
 * the same degradation, and ending the window at 3x would report it as over.
 */
export const LATENCY_RECOVERY_FACTOR = 1.5;

/** Per-tick failures above this share of that tick's completions is a burst. */
export const ERROR_BURST_RATE = 0.01;

/** Throughput under this share of its trailing median is a drop. */
export const THROUGHPUT_DROP_FACTOR = 0.6;

/**
 * Ticks a condition must hold for. One tick is noise - a single scrape landing
 * beside a GC pause - and flagging it would fill a clean run with events.
 */
export const MIN_CONSECUTIVE_TICKS = 2;

/** Most anomalies reported; beyond this the list stops being readable. */
export const MAX_ANOMALIES = 20;

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Median of the {@link BASELINE_TICKS} ticks *before* each index - `null` until
 * that much history exists, which is what makes the opening seconds of a run
 * (where every value is its own outlier) produce nothing.
 */
function trailingMedians(values: number[]): Array<number | null> {
	return values.map((_, i) =>
		i < BASELINE_TICKS ? null : median(values.slice(i - BASELINE_TICKS, i))
	);
}

/**
 * Maximal runs of consecutive ticks satisfying `isHot`, at least
 * {@link MIN_CONSECUTIVE_TICKS} long, as inclusive `[start, end]` index pairs.
 * Runs are disjoint and ordered by construction, so no merge pass is needed
 * downstream.
 */
function findRuns(length: number, isHot: (i: number) => boolean): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	let i = 0;
	while (i < length) {
		if (!isHot(i)) {
			i++;
			continue;
		}
		const start = i;
		while (i < length && isHot(i)) i++;
		if (i - start >= MIN_CONSECUTIVE_TICKS) runs.push([start, i - 1]);
	}
	return runs;
}

/** Seconds, at the precision a reader can act on: "3s", "0.4s". */
function formatSeconds(seconds: number): string {
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${Number(seconds.toFixed(1))}s`;
}

function span(history: LoadTestMetrics[], start: number, end: number): string {
	return formatSeconds(history[end].elapsed_seconds - history[start].elapsed_seconds);
}

function detectLatencySpikes(history: LoadTestMetrics[]): Anomaly[] {
	const p99 = history.map((m) => m.latency_p99_ms ?? 0);
	const baselines = trailingMedians(p99);
	const isHot = (i: number) => {
		const base = baselines[i];
		return base != null && base > 0 && p99[i] > base * LATENCY_SPIKE_FACTOR;
	};

	const out: Anomaly[] = [];
	let consumedThrough = -1;
	for (const [start, hotEnd] of findRuns(history.length, isHot)) {
		// A window that the previous one already swallowed during its recovery
		// extension is the same degradation, not a second one.
		if (start <= consumedThrough) continue;
		/*
		 * The baseline is frozen at the opening tick. Recomputing it as the window
		 * extends would fold the spike's own ticks into the trailing median, so a
		 * long degradation would raise its own bar and report itself as recovered
		 * while it was still happening.
		 */
		const base = baselines[start] as number;
		let end = hotEnd;
		while (end + 1 < history.length && p99[end + 1] > base * LATENCY_RECOVERY_FACTOR) end++;
		consumedThrough = end;

		let peak = 0;
		for (let i = start; i <= end; i++) peak = Math.max(peak, p99[i]);
		const magnitude = peak / base;
		out.push({
			kind: "latency_spike",
			startSeconds: history[start].elapsed_seconds,
			endSeconds: history[end].elapsed_seconds,
			magnitude,
			label: `p99 ${magnitude.toFixed(1)}x baseline for ${span(history, start, end)}`,
		});
	}
	return out;
}

function detectErrorBursts(history: LoadTestMetrics[]): Anomaly[] {
	/*
	 * `requests_failed` and `requests_completed` are cumulative counters, so the
	 * rate that matters is the per-tick delta. Reading them undiffed would report
	 * a run that failed early and recovered as failing for the rest of its life.
	 */
	const rate = history.map((m, i) => {
		if (i === 0) return 0;
		const failed = Math.max(
			0,
			(m.requests_failed ?? 0) - (history[i - 1].requests_failed ?? 0)
		);
		const completed = Math.max(0, m.requests_completed - history[i - 1].requests_completed);
		return completed > 0 ? failed / completed : 0;
	});

	return findRuns(history.length, (i) => rate[i] > ERROR_BURST_RATE).map(([start, end]) => {
		let peak = 0;
		for (let i = start; i <= end; i++) peak = Math.max(peak, rate[i]);
		return {
			kind: "error_burst" as const,
			startSeconds: history[start].elapsed_seconds,
			endSeconds: history[end].elapsed_seconds,
			magnitude: peak / ERROR_BURST_RATE,
			label: `errors ${(peak * 100).toFixed(1)}% of requests for ${span(history, start, end)}`,
		};
	});
}

function detectThroughputDrops(history: LoadTestMetrics[]): Anomaly[] {
	const rps = history.map((m) => m.current_rps ?? 0);
	const concurrency = history.map((m) => m.current_concurrency ?? 0);
	const rpsBaselines = trailingMedians(rps);
	const concurrencyBaselines = trailingMedians(concurrency);

	const isHot = (i: number) => {
		const base = rpsBaselines[i];
		if (base == null || base <= 0) return false;
		// Concurrency held: a ramp winding down, or a stopped run, produces less
		// throughput because it was asked to. That is not a degradation.
		const heldConcurrency = concurrency[i] >= (concurrencyBaselines[i] ?? 0);
		return heldConcurrency && rps[i] < base * THROUGHPUT_DROP_FACTOR;
	};

	return findRuns(history.length, isHot).map(([start, end]) => {
		const base = rpsBaselines[start] as number;
		let trough = Infinity;
		for (let i = start; i <= end; i++) trough = Math.min(trough, rps[i]);
		const share = trough / base;
		return {
			kind: "throughput_drop" as const,
			startSeconds: history[start].elapsed_seconds,
			endSeconds: history[end].elapsed_seconds,
			// trough can be 0 (throughput stopped entirely) - report that as the
			// worst possible multiple rather than as Infinity.
			magnitude: share > 0 ? 1 / share : Number.MAX_SAFE_INTEGER,
			label: `throughput ${Math.round(share * 100)}% of baseline for ${span(history, start, end)}`,
		};
	});
}

function detectFirst5xx(history: LoadTestMetrics[]): Anomaly[] {
	for (const m of history) {
		// The map is cumulative, so the tick a 5xx key first appears on with a
		// non-zero count IS the onset - no diffing needed to find the first one.
		const code = Object.entries(m.status_codes ?? {}).find(
			([status, count]) => count > 0 && Number(status) >= 500 && Number(status) < 600
		);
		if (!code) continue;
		return [
			{
				kind: "first_5xx",
				startSeconds: m.elapsed_seconds,
				endSeconds: m.elapsed_seconds,
				magnitude: 1,
				label: `first ${code[0]} response`,
			},
		];
	}
	return [];
}

/**
 * Every anomaly in a run's per-tick series, in time order.
 *
 * Returns `[]` for a clean run - and for a run too short to have a baseline,
 * which is the same answer for the same reason: nothing here is established
 * enough to be abnormal.
 */
export function detectAnomalies(history: LoadTestMetrics[]): Anomaly[] {
	if (history.length < 2) return [];

	const found = [
		...detectLatencySpikes(history),
		...detectErrorBursts(history),
		...detectThroughputDrops(history),
		...detectFirst5xx(history),
	];

	const byTime = (a: Anomaly, b: Anomaly) => a.startSeconds - b.startSeconds;
	if (found.length <= MAX_ANOMALIES) return found.sort(byTime);

	// Over the cap the list is triaged, not truncated: the worst survive, and the
	// last one says how many did not - a silently shortened list reads as a
	// complete one.
	const kept = [...found].sort((a, b) => b.magnitude - a.magnitude).slice(0, MAX_ANOMALIES);
	kept.sort(byTime);
	const dropped = found.length - kept.length;
	const last = kept[kept.length - 1];
	kept[kept.length - 1] = { ...last, label: `${last.label} (+${dropped} more)` };
	return kept;
}
