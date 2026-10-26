/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { computeBreakpoint, DEFAULT_SLO_MS, notCrossed, sloSourceOf } from "./computeBreakpoint";

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

describe("computeBreakpoint", () => {
	it("finds the first tick where p99 crosses the SLO threshold and reports its concurrency", () => {
		const bp = computeBreakpoint(
			[
				tick({ elapsed_seconds: 1, current_concurrency: 10, latency_p99_ms: 50 }),
				tick({ elapsed_seconds: 2, current_concurrency: 20, latency_p99_ms: 120 }),
				tick({ elapsed_seconds: 3, current_concurrency: 30, latency_p99_ms: 260 }),
				tick({ elapsed_seconds: 4, current_concurrency: 40, latency_p99_ms: 800 }),
			],
			200
		);
		expect(bp.crossed).toBe(true);
		expect(bp.concurrency).toBe(30);
		expect(bp.timeSeconds).toBe(3);
		expect(bp.p99Ms).toBe(260);
		expect(bp.sloMs).toBe(200);
	});

	it("passes over a stored second with no completion (#2386)", () => {
		// The engine writes no percentile keys for it: nothing to latch on.
		const stall = tick({ elapsed_seconds: 2, current_concurrency: 20 });
		delete stall.latency_p50_ms;
		delete stall.latency_p95_ms;
		delete stall.latency_p99_ms;
		const bp = computeBreakpoint(
			[
				tick({ elapsed_seconds: 1, current_concurrency: 10, latency_p99_ms: 50 }),
				stall,
				tick({ elapsed_seconds: 3, current_concurrency: 30, latency_p99_ms: 260 }),
			],
			200
		);
		expect(bp).toMatchObject({ crossed: true, timeSeconds: 3, concurrency: 30, p99Ms: 260 });
	});

	it("reports not-crossed when p99 stays under threshold throughout", () => {
		const bp = computeBreakpoint(
			[
				tick({ current_concurrency: 10, latency_p99_ms: 50 }),
				tick({ current_concurrency: 20, latency_p99_ms: 120 }),
			],
			200
		);
		expect(bp.crossed).toBe(false);
		expect(bp.concurrency).toBeNull();
		expect(bp.sloMs).toBe(200);
	});

	it("carries the threshold it was given, not the default", () => {
		const under = [tick({ latency_p99_ms: 120 })];
		expect(computeBreakpoint(under, 350).sloMs).toBe(350);
		expect(computeBreakpoint([tick({ latency_p99_ms: 400 })], 350).sloMs).toBe(350);
	});

	it("defaults the SLO threshold to 200ms", () => {
		expect(DEFAULT_SLO_MS).toBe(200);
		const bp = computeBreakpoint([tick({ current_concurrency: 25, latency_p99_ms: 201 })]);
		expect(bp.crossed).toBe(true);
		expect(bp.concurrency).toBe(25);
	});

	it("handles empty history", () => {
		const bp = computeBreakpoint([], 200);
		expect(bp.crossed).toBe(false);
		expect(bp.concurrency).toBeNull();
		expect(bp.sloMs).toBe(200);
	});
});

describe("computeBreakpoint on a live series (issue #2385)", () => {
	it("is not latched by a window p99 between gates, and is by a gate's second", () => {
		const history = [
			// A ~100 ms window that read high: not a second's p99.
			tick({ live: true, elapsed_seconds: 0.5, current_concurrency: 5, latency_p99_ms: 900 }),
			tick({
				live: true,
				elapsed_seconds: 1,
				current_concurrency: 10,
				latency_p99_ms: 900,
				second_samples: 50,
				second_p50_ms: 10,
				second_p95_ms: 20,
				second_p99_ms: 120,
			}),
			tick({
				live: true,
				elapsed_seconds: 2,
				current_concurrency: 20,
				second_samples: 50,
				second_p50_ms: 10,
				second_p95_ms: 90,
				second_p99_ms: 400,
			}),
		];
		const bp = computeBreakpoint(history, 200);
		expect(bp.crossed).toBe(true);
		expect(bp.concurrency).toBe(20);
		expect(bp.timeSeconds).toBe(2);
		expect(bp.p99Ms).toBe(400);
	});

	it("does not cross on a series of windows alone", () => {
		const windows = [1, 2, 3].map((s) =>
			tick({ live: true, elapsed_seconds: s, latency_p99_ms: 900 })
		);
		expect(computeBreakpoint(windows, 200).crossed).toBe(false);
	});
});

describe("computeBreakpoint atRunStart", () => {
	it("is set when the first tick is already over the SLO", () => {
		const bp = computeBreakpoint(
			[tick({ elapsed_seconds: 1, latency_p99_ms: 400 }), tick({ latency_p99_ms: 500 })],
			200
		);
		expect(bp).toMatchObject({ crossed: true, timeSeconds: 1, atRunStart: true });
	});

	it("is clear when an earlier tick read under the SLO", () => {
		const bp = computeBreakpoint(
			[
				tick({ elapsed_seconds: 1, latency_p99_ms: 50 }),
				tick({ elapsed_seconds: 2, latency_p99_ms: 400 }),
			],
			200
		);
		expect(bp).toMatchObject({ crossed: true, timeSeconds: 2, atRunStart: false });
	});

	it("counts the first tick that held a reading, not the first tick", () => {
		// A stored second with no completion has no p99: it is no reading under
		// the SLO, so a crossing right after it is still the run's first.
		const stall = tick({ elapsed_seconds: 1 });
		delete stall.latency_p99_ms;
		const bp = computeBreakpoint(
			[stall, tick({ elapsed_seconds: 2, latency_p99_ms: 400 })],
			200
		);
		expect(bp).toMatchObject({ crossed: true, timeSeconds: 2, atRunStart: true });
	});

	it("does not count a live window between gates as a reading", () => {
		const gate = (s: number, p99: number) =>
			tick({
				live: true,
				elapsed_seconds: s,
				second_samples: 50,
				second_p50_ms: 10,
				second_p95_ms: 20,
				second_p99_ms: p99,
			});
		const window = tick({ live: true, elapsed_seconds: 0.5, latency_p99_ms: 20 });
		expect(computeBreakpoint([window, gate(1, 300)], 200).atRunStart).toBe(true);
		expect(computeBreakpoint([window, gate(1, 100), gate(2, 300)], 200).atRunStart).toBe(false);
	});

	it("is clear on a series that never crossed", () => {
		expect(computeBreakpoint([tick({ latency_p99_ms: 50 })], 200).atRunStart).toBe(false);
		expect(computeBreakpoint([], 200).atRunStart).toBe(false);
	});
});

describe("breakpoint sloSource (#2939)", () => {
	const crossing = [tick({ elapsed_seconds: 1, latency_p99_ms: 260 })];
	const quiet = [tick({ elapsed_seconds: 1, latency_p99_ms: 50 })];

	it("is the Settings threshold when the run declared no line of its own", () => {
		expect(computeBreakpoint(crossing, 200).sloSource).toBe("settings");
		expect(computeBreakpoint(quiet, 200).sloSource).toBe("settings");
	});

	it("is the run's when the judged value is the run's own line", () => {
		expect(computeBreakpoint(crossing, 250, 250).sloSource).toBe("run");
		expect(computeBreakpoint(quiet, 250, 250).sloSource).toBe("run");
	});

	it("stays Settings when the run's own line differs from the judged one", () => {
		// A ramp with a 350ms p99 budget is still judged against Settings' 200ms.
		const bp = computeBreakpoint(crossing, 200, 350);
		expect(bp).toMatchObject({ sloMs: 200, sloSource: "settings" });
	});

	it("is carried by notCrossed and an empty series", () => {
		expect(notCrossed(50, "run").sloSource).toBe("run");
		expect(computeBreakpoint([], 200, 200).sloSource).toBe("run");
	});

	it("sloSourceOf reads no source into a missing judgement or a missing run line", () => {
		expect(sloSourceOf(null, undefined)).toBe("settings");
		expect(sloSourceOf(200, undefined)).toBe("settings");
		expect(sloSourceOf(200, 200)).toBe("run");
	});
});
