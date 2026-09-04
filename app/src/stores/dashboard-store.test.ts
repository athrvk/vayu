/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore, deriveRunProgress } from "./dashboard-store";
import type { LoadTestMetrics } from "@/types";

function tick(elapsed: number, p99 = 10): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: Math.round(elapsed),
		latency_p50_ms: 5,
		latency_p95_ms: 8,
		latency_p99_ms: p99,
		avg_latency_ms: 6,
		bytes_sent: 0,
		bytes_received: 0,
	};
}

describe("dashboard-store live retention window", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	it("trims ticks older than the time window (measured from the newest tick)", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => tick(i * 10))); // 0..120s

		const hist = useDashboardStore.getState().historicalMetrics;
		// Newest = 120s, cutoff = 60s → keep 60,70,…,120 (7 ticks).
		expect(hist).toHaveLength(7);
		expect(hist[0].elapsed_seconds).toBe(60);
		expect(hist[hist.length - 1].elapsed_seconds).toBe(120);
	});

	it("keeps everything when the window is 'full' (null)", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(null);
		s.addMetricsBatch(Array.from({ length: 500 }, (_, i) => tick(i)));
		expect(useDashboardStore.getState().historicalMetrics).toHaveLength(500);
	});

	// The ceiling is the engine's `liveMaxRetainedTicks`, synced in by
	// useLiveChartSettings - so the trim has to read the store's value, not a
	// module constant, or raising the setting would enlarge the engine's ring
	// while this side kept discarding at the old number.
	it("trims to the configured tick ceiling, not a fixed constant", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(null); // full run - the ceiling is the only bound
		s.setMaxRetainedTicks(120);
		s.addMetricsBatch(Array.from({ length: 500 }, (_, i) => tick(i)));

		const hist = useDashboardStore.getState().historicalMetrics;
		expect(hist).toHaveLength(120);
		// The newest are kept, so the chart's right edge stays live.
		expect(hist[hist.length - 1].elapsed_seconds).toBe(499);
		expect(hist[0].elapsed_seconds).toBe(380);
	});

	it("ignores a non-positive ceiling rather than emptying the history", () => {
		const s = useDashboardStore.getState();
		s.setMaxRetainedTicks(0);
		expect(useDashboardStore.getState().maxRetainedTicks).toBe(50000);
	});

	it("latched aggregates survive ticks rolling out of the window", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		// A crossing at t=5s (p99 over the 200ms SLO), then advance well past the window.
		s.addMetricsBatch([tick(5, 250)]);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => tick(70 + i * 5)));

		const state = useDashboardStore.getState();
		// The crossing tick (t=5) has rolled off, but the breakpoint stays latched.
		expect(state.historicalMetrics.some((m) => m.elapsed_seconds === 5)).toBe(false);
		expect(state.breakpoint.crossed).toBe(true);
		expect(state.breakpoint.timeSeconds).toBe(5);
		expect(state.breakpoint.p99Ms).toBe(250);
	});
});

describe("dashboard-store monitor samples", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	it("starts empty, so a run without a monitor draws no vitals row", () => {
		expect(useDashboardStore.getState().monitorSamples).toEqual([]);
	});

	it("appends scrapes in arrival order", () => {
		const s = useDashboardStore.getState();
		s.addMonitorSamples([{ timestamp: 1000, series: { cpu: 1 } }]);
		s.addMonitorSamples([{ timestamp: 2000, series: { cpu: 2 } }]);

		expect(useDashboardStore.getState().monitorSamples.map((m) => m.timestamp)).toEqual([
			1000, 2000,
		]);
	});

	it("bounds the buffer by the retained-tick ceiling", () => {
		// A scrape can be configured faster than the tick cadence, so this array
		// needs its own cap - an overnight soak at 250ms would otherwise grow
		// without limit beside a series that is trimmed.
		const s = useDashboardStore.getState();
		s.setMaxRetainedTicks(5);
		s.addMonitorSamples(
			Array.from({ length: 12 }, (_, i) => ({ timestamp: i, series: { cpu: i } }))
		);

		const kept = useDashboardStore.getState().monitorSamples;
		expect(kept).toHaveLength(5);
		expect(kept[0].timestamp).toBe(7);
	});

	it("clears the samples when a new run starts", () => {
		const s = useDashboardStore.getState();
		s.addMonitorSamples([{ timestamp: 1000, series: { cpu: 1 } }]);
		useDashboardStore.getState().startRun("r2");
		expect(useDashboardStore.getState().monitorSamples).toEqual([]);
	});
});

/**
 * How far through a run one tick is, for the taskbar and Dock indicator
 * (#1362). Pure, and read by `LoadTestService` on every committed batch.
 */
describe("deriveRunProgress", () => {
	it("prefers the engine's own expected count", () => {
		const progress = deriveRunProgress(
			{ duration: "60s" },
			{ ...tick(30), requests_sent: 250, requests_expected: 1000 }
		);
		// Elapsed over duration would say 0.5 here; the engine's arithmetic wins.
		expect(progress).toBe(0.25);
	});

	it("falls back to elapsed over duration when no count is published", () => {
		expect(deriveRunProgress({ duration: "60s" }, tick(15))).toBe(0.25);
	});

	it("reads the units the engine accepts", () => {
		expect(deriveRunProgress({ duration: "2m" }, tick(30))).toBe(0.25);
		expect(deriveRunProgress({ duration: "1h" }, tick(900))).toBe(0.25);
		expect(deriveRunProgress({ duration: "60000ms" }, tick(15))).toBe(0.25);
		// A bare number is seconds, the way the engine reads a numeric duration.
		expect(deriveRunProgress({ duration: "60" }, tick(15))).toBe(0.25);
	});

	it("has no fraction for an open-ended run", () => {
		expect(deriveRunProgress({ targetRps: 100 }, tick(30))).toBeNull();
		expect(deriveRunProgress(null, tick(30))).toBeNull();
		expect(deriveRunProgress({ duration: "60s" }, null)).toBeNull();
		// An expected count of 0 is how the engine says "open-ended", not "done".
		expect(
			deriveRunProgress({}, { ...tick(30), requests_sent: 250, requests_expected: 0 })
		).toBeNull();
	});

	it("refuses a duration it cannot read rather than guessing at one", () => {
		expect(deriveRunProgress({ duration: "soon" }, tick(30))).toBeNull();
		expect(deriveRunProgress({ duration: "0s" }, tick(30))).toBeNull();
	});

	/*
	 * Mutation check: drop the clamp and a run that overshoots its own expected
	 * count - the last window's requests land after the bound - reports a
	 * fraction above 1, which Electron reads as an indeterminate bar.
	 */
	it("stays inside 0..1 when a run overshoots", () => {
		expect(
			deriveRunProgress({}, { ...tick(30), requests_sent: 1100, requests_expected: 1000 })
		).toBe(1);
		expect(deriveRunProgress({ duration: "10s" }, tick(30))).toBe(1);
	});
});
