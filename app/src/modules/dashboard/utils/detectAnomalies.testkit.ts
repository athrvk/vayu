/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The anomaly detector as it stood before #1151 made it incremental: one pass
 * over the whole series, no state, nothing cached. Test-only.
 *
 * This is the oracle. `detectAnomalies` is now a thin wrapper over
 * `createAnomalyDetector`, so comparing the two proves only that a detector
 * carries no state between buffers - not that either still answers what the
 * detector answered before the rewrite, which is what #1151's second acceptance
 * criterion actually asks. Only an independent implementation can say that, and
 * this is that implementation, taken verbatim from `db346d3`.
 *
 * It is a deliberate copy and it is meant to stay one. A rule change has to be
 * made here as well, on purpose, with the equivalence tests failing in between -
 * that failure is the point. Do not import it from anything that ships.
 */

import type { LoadTestMetrics } from "@/types";
import {
	type Anomaly,
	BASELINE_TICKS,
	LATENCY_SPIKE_FACTOR,
	LATENCY_RECOVERY_FACTOR,
	ERROR_BURST_RATE,
	THROUGHPUT_DROP_FACTOR,
	MIN_CONSECUTIVE_TICKS,
	MAX_ANOMALIES,
} from "./detectAnomalies";

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
export function detectAnomaliesFromScratch(history: LoadTestMetrics[]): Anomaly[] {
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
