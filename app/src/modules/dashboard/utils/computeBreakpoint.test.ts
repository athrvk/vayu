/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { computeBreakpoint, DEFAULT_SLO_MS } from "./computeBreakpoint";

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
	});
});
