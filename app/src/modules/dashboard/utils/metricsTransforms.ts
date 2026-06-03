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

/** A run is "rate limited" (can drop requests) only in constant_rps with a target. */
export function isRateLimitedRun(mode: string | undefined, targetRps: number | undefined): boolean {
	return mode === "constant_rps" && (targetRps ?? 0) > 0;
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
		const t = Math.round(m.elapsed_seconds * 2) / 2;
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
	// deficit-only "ramp lag", overshoot (achieved >> configured) is counted —
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
		const t = Math.round(m.elapsed_seconds * 2) / 2;
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
		const t = Math.round(m.elapsed_seconds * 2) / 2;
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
