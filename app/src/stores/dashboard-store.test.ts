/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./dashboard-store";
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
