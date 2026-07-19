/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { bucketColumns, rebucket, pickThroughput, pickErrorRate } from "./buildData";

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

describe("bucketColumns", () => {
	it("buckets to 0.5s, last-write-wins, sorted, aligned columns", () => {
		const history = [
			tick({ elapsed_seconds: 0.1, throughput: 100, current_rps: 90 }), // → bucket 0.0
			tick({ elapsed_seconds: 0.3, throughput: 110, current_rps: 95 }), // → bucket 0.5
			tick({ elapsed_seconds: 0.6, throughput: 200, current_rps: 190 }), // → bucket 0.5 (wins)
			tick({ elapsed_seconds: 1.0, throughput: 300, current_rps: 290 }), // → bucket 1.0
		];
		const { times, cols } = bucketColumns(history, [pickThroughput]);
		expect(times).toEqual([0, 0.5, 1]);
		expect(cols[0]).toEqual([100, 200, 300]);
	});

	it("falls back throughput → current_rps when throughput is absent", () => {
		const { cols } = bucketColumns(
			[tick({ elapsed_seconds: 0, current_rps: 42 })],
			[pickThroughput]
		);
		expect(cols[0]).toEqual([42]);
	});

	it("derives error-rate percentage from completed/failed", () => {
		const { cols } = bucketColumns(
			[tick({ elapsed_seconds: 0, requests_completed: 200, requests_failed: 10 })],
			[pickErrorRate]
		);
		expect(cols[0][0]).toBeCloseTo(5, 5);
	});

	it("honors a custom bucket width (2s coarsens 0.5s ticks)", () => {
		const history = [
			tick({ elapsed_seconds: 0.5, throughput: 10 }), // → bucket 0
			tick({ elapsed_seconds: 1.5, throughput: 20 }), // → bucket 2 (round(1.5/2)*2)
			tick({ elapsed_seconds: 3.4, throughput: 30 }), // → bucket 4
		];
		const { times, cols } = bucketColumns(history, [pickThroughput], 2);
		expect(times).toEqual([0, 2, 4]);
		expect(cols[0]).toEqual([10, 20, 30]);
	});
});

describe("rebucket", () => {
	it("re-buckets aligned series to a coarser width, last-write-wins", () => {
		const times = [0, 0.5, 1, 1.5, 2];
		const p99 = [10, 20, 30, 40, 50];
		const { times: outT, cols } = rebucket(times, [p99], 1);
		// round(t): 0→0 (10); 0.5→1 (20) then 1→1 (30 wins); 1.5→2 (40) then 2→2 (50 wins)
		expect(outT).toEqual([0, 1, 2]);
		expect(cols[0]).toEqual([10, 30, 50]);
	});

	it("defaults to 0.5s and preserves per-tick points at that rate", () => {
		const times = [0, 0.5, 1];
		const { times: outT, cols } = rebucket(times, [[1, 2, 3]]);
		expect(outT).toEqual([0, 0.5, 1]);
		expect(cols[0]).toEqual([1, 2, 3]);
	});
});
