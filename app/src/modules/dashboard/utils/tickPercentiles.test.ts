/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { cumulativePercentiles, hasSecondPercentiles, secondPercentiles } from "./tickPercentiles";

function tick(partial: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 1,
		latency_p95_ms: 2,
		latency_p99_ms: 3,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		...partial,
	};
}

describe("secondPercentiles (issue #2385)", () => {
	it("reads a stored tick's own latency_p*_ms, which are its second's already", () => {
		expect(secondPercentiles(tick({}))).toEqual({ p50: 1, p95: 2, p99: 3 });
		expect(hasSecondPercentiles(tick({}))).toBe(true);
	});

	it("reads a gate frame's second_p*, never the window on the same frame", () => {
		const gate = tick({
			live: true,
			second_samples: 900,
			second_p50_ms: 10,
			second_p95_ms: 20,
			second_p99_ms: 300,
			latency_p99_ms: 5,
		});
		expect(secondPercentiles(gate)).toEqual({ p50: 10, p95: 20, p99: 300 });
	});

	it("holds nothing for a live frame between gates, whatever its window says", () => {
		const between = tick({ live: true, latency_p99_ms: 999 });
		expect(secondPercentiles(between)).toBeNull();
		expect(hasSecondPercentiles(between)).toBe(false);
	});

	it("holds nothing for a gate frame of an idle second", () => {
		const idle = tick({
			live: true,
			second_samples: 0,
			second_p50_ms: null,
			second_p95_ms: null,
			second_p99_ms: null,
		});
		expect(secondPercentiles(idle)).toBeNull();
	});

	it("holds nothing for a gate frame whose percentiles are null despite a count", () => {
		const odd = tick({ live: true, second_samples: 5, second_p99_ms: null });
		expect(secondPercentiles(odd)).toBeNull();
	});
});

describe("cumulativePercentiles (issue #2385)", () => {
	it("reads the run-so-far keys of a live frame, not its window", () => {
		const live = tick({
			live: true,
			latency_p99_ms: 5,
			cumulative_p50_ms: 11,
			cumulative_p95_ms: 22,
			cumulative_p99_ms: 330,
		});
		expect(cumulativePercentiles(live)).toEqual({ p50: 11, p95: 22, p99: 330 });
	});

	it("reads 0 for a live frame that has sampled nothing yet, not the window", () => {
		const first = tick({
			live: true,
			cumulative_p50_ms: null,
			cumulative_p95_ms: null,
			cumulative_p99_ms: null,
		});
		expect(cumulativePercentiles(first)).toEqual({ p50: 0, p95: 0, p99: 0 });
	});

	it("falls back to latency_p*_ms for a tick without the keys", () => {
		expect(cumulativePercentiles(tick({}))).toEqual({ p50: 1, p95: 2, p99: 3 });
	});
});
