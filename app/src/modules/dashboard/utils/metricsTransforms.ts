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
export function isRateLimitedRun(
	mode: string | undefined,
	targetRps: number | undefined
): boolean {
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
	rampLagPct: number; // latest ramp_lag from the engine
	peakAchieved: number;
	target: number;
}

export interface RampParams {
	rampUpDurationSeconds?: number;
	startConcurrency?: number;
	targetConcurrency?: number;
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
	let lastLag = 0;
	for (const m of history) {
		const t = Math.round(m.elapsed_seconds * 2) / 2;
		const achieved = m.current_concurrency ?? 0;
		if (achieved > peak) peak = achieved;
		if (m.ramp_lag != null) lastLag = m.ramp_lag;
		const configured =
			rampSec > 0 && t < rampSec ? start + (target - start) * (t / rampSec) : target;
		byBucket.set(t, { time: t, configured, achieved });
	}
	return {
		points: Array.from(byBucket.values()).sort((a, b) => a.time - b.time),
		rampLagPct: lastLag,
		peakAchieved: peak,
		target,
	};
}
