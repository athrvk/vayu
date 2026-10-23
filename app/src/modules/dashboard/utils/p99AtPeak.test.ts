/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { computeBreakpoint } from "./computeBreakpoint";
import { foldPeakReading, NO_PEAK_READING, p99AtPeak } from "./p99AtPeak";

function tick(partial: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 0,
		latency_p95_ms: 0,
		latency_p99_ms: 0,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		...partial,
	};
}

/** A ramp 1 -> 30 virtual users over 30 stored seconds; p99 grows with load. */
function rampSeries(p99At: (vu: number) => number): LoadTestMetrics[] {
	return Array.from({ length: 30 }, (_, i) =>
		tick({
			elapsed_seconds: i + 1,
			current_concurrency: i + 1,
			latency_p99_ms: p99At(i + 1),
		})
	);
}

describe("p99AtPeak", () => {
	it("reads the peak-load tick, not the tick where the SLO was first crossed", () => {
		// Crosses the 200 ms SLO at 19 virtual users (203 ms) and keeps climbing.
		const series = rampSeries((vu) => (vu < 19 ? 50 + vu : 203 + (vu - 19) * 8));
		const bp = computeBreakpoint(series, 200);
		expect(bp.concurrency).toBe(19);
		expect(bp.p99Ms).toBe(203);
		expect(p99AtPeak(series)).toBe(203 + 11 * 8);
		expect(p99AtPeak(series)).not.toBe(bp.p99Ms);
	});

	it("takes the largest p99 among several ticks held at the peak", () => {
		const series = [
			tick({ current_concurrency: 10, latency_p99_ms: 400 }),
			tick({ current_concurrency: 30, latency_p99_ms: 120 }),
			tick({ current_concurrency: 30, latency_p99_ms: 180 }),
			tick({ current_concurrency: 30, latency_p99_ms: 150 }),
		];
		expect(p99AtPeak(series)).toBe(180);
	});

	it("is undefined for an empty series", () => {
		expect(p99AtPeak([])).toBeUndefined();
	});

	it("is undefined when no tick at the peak held a whole-second p99", () => {
		const stall = tick({ current_concurrency: 30 });
		delete stall.latency_p50_ms;
		delete stall.latency_p95_ms;
		delete stall.latency_p99_ms;
		expect(
			p99AtPeak([tick({ current_concurrency: 10, latency_p99_ms: 90 }), stall])
		).toBeUndefined();
	});

	it("skips a tick at the peak with no whole-second p99 and keeps the one that has it", () => {
		const stall = tick({ current_concurrency: 30 });
		delete stall.latency_p99_ms;
		const window: LoadTestMetrics = {
			...tick({ current_concurrency: 30, latency_p99_ms: 9000 }),
			live: true,
		};
		expect(
			p99AtPeak([tick({ current_concurrency: 30, latency_p99_ms: 210 }), stall, window])
		).toBe(210);
	});

	it("reads a gate frame's second p99, not the window figure beside it", () => {
		const gate: LoadTestMetrics = {
			...tick({ current_concurrency: 20, latency_p99_ms: 9000 }),
			live: true,
			second_samples: 80,
			second_p50_ms: 5,
			second_p95_ms: 8,
			second_p99_ms: 310,
		};
		expect(p99AtPeak([gate])).toBe(310);
	});

	it("restarts when the peak rises: a hotter earlier plateau does not outvote the new peak", () => {
		const series = [
			tick({ current_concurrency: 10, latency_p99_ms: 500 }),
			tick({ current_concurrency: 10, latency_p99_ms: 480 }),
			tick({ current_concurrency: 20, latency_p99_ms: 100 }),
		];
		expect(p99AtPeak(series)).toBe(100);
	});

	it("does not let a lower-load tick after the peak change the reading", () => {
		const series = [
			tick({ current_concurrency: 30, latency_p99_ms: 100 }),
			tick({ current_concurrency: 5, latency_p99_ms: 900 }),
		];
		expect(p99AtPeak(series)).toBe(100);
	});

	it("is the fold of its ticks, one at a time", () => {
		const a = tick({ current_concurrency: 4, latency_p99_ms: 40 });
		const b = tick({ current_concurrency: 8, latency_p99_ms: 80 });
		const step = foldPeakReading(foldPeakReading(NO_PEAK_READING, a), b);
		expect(step).toEqual({ peak: 8, p99Ms: 80 });
	});
});
