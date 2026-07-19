/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { bucketColumns, pickThroughput, pickErrorRate } from "./buildData";

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
});
