import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import { isRateLimitedRun, buildLatencyChartData, buildRampOverlay, buildPercentileChartData } from "./metricsTransforms";

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

describe("isRateLimitedRun", () => {
	it("is true only for constant_rps with a positive targetRps", () => {
		expect(isRateLimitedRun("constant_rps", 100)).toBe(true);
		expect(isRateLimitedRun("constant_rps", 0)).toBe(false);
		expect(isRateLimitedRun("constant_rps", undefined)).toBe(false);
		expect(isRateLimitedRun("ramp_up", 100)).toBe(false);
		expect(isRateLimitedRun("iterations", 100)).toBe(false);
		expect(isRateLimitedRun(undefined, 100)).toBe(false);
	});
});

describe("buildLatencyChartData", () => {
	it("derives wire = latency - queue_wait, clamped >= 0", () => {
		const data = buildLatencyChartData([
			tick({ elapsed_seconds: 1, avg_latency_ms: 50, avg_queue_wait_ms: 10 }),
			tick({ elapsed_seconds: 2, avg_latency_ms: 80, avg_queue_wait_ms: 30 }),
		]);
		expect(data).toHaveLength(2);
		expect(data[0]).toMatchObject({ time: 1, latencyMs: 50, wireMs: 40, queueWaitMs: 10 });
		expect(data[1]).toMatchObject({ time: 2, latencyMs: 80, wireMs: 50, queueWaitMs: 30 });
	});

	it("treats missing queue_wait as 0 (older runs) so wire == latency", () => {
		const data = buildLatencyChartData([tick({ elapsed_seconds: 1, avg_latency_ms: 42 })]);
		expect(data[0]).toMatchObject({ latencyMs: 42, wireMs: 42, queueWaitMs: 0 });
	});

	it("buckets ticks to 0.5s, last-write-wins, sorted by time", () => {
		const data = buildLatencyChartData([
			tick({ elapsed_seconds: 1.1, avg_latency_ms: 10 }),
			tick({ elapsed_seconds: 1.2, avg_latency_ms: 20 }),
			tick({ elapsed_seconds: 0.6, avg_latency_ms: 5 }),
		]);
		expect(data.map((d) => d.time)).toEqual([0.5, 1.0]);
		expect(data[1].latencyMs).toBe(20);
	});
});

describe("buildRampOverlay", () => {
	it("returns null when targetConcurrency is missing", () => {
		expect(buildRampOverlay([], { rampUpDurationSeconds: 10, startConcurrency: 1 })).toBeNull();
	});

	it("builds a linear configured curve during ramp, flat at target after", () => {
		const overlay = buildRampOverlay(
			[
				tick({ elapsed_seconds: 0, current_concurrency: 1 }),
				tick({ elapsed_seconds: 5, current_concurrency: 40 }),
				tick({ elapsed_seconds: 10, current_concurrency: 80 }),
				tick({ elapsed_seconds: 15, current_concurrency: 90, ramp_lag: 18.5 }),
			],
			{ rampUpDurationSeconds: 10, startConcurrency: 0, targetConcurrency: 100 }
		)!;
		const at5 = overlay.points.find((p) => p.time === 5)!;
		expect(at5.configured).toBeCloseTo(50);
		expect(at5.achieved).toBe(40);
		const at15 = overlay.points.find((p) => p.time === 15)!;
		expect(at15.configured).toBe(100);
		expect(overlay.rampLagPct).toBeCloseTo(18.5);
		expect(overlay.peakAchieved).toBe(90);
		expect(overlay.target).toBe(100);
	});
});

describe("buildPercentileChartData", () => {
	it("buckets p50/p95/p99 per tick, sorted by time", () => {
		const data = buildPercentileChartData([
			tick({ elapsed_seconds: 1, latency_p50_ms: 10, latency_p95_ms: 40, latency_p99_ms: 80 }),
			tick({ elapsed_seconds: 2, latency_p50_ms: 12, latency_p95_ms: 60, latency_p99_ms: 150 }),
		]);
		expect(data).toHaveLength(2);
		expect(data[0]).toMatchObject({ time: 1, p50: 10, p95: 40, p99: 80 });
		expect(data[1]).toMatchObject({ time: 2, p50: 12, p95: 60, p99: 150 });
	});

	it("zeroes percentiles for older runs that lack them", () => {
		const all = buildPercentileChartData([
			tick({ elapsed_seconds: 1 }),
			tick({ elapsed_seconds: 2 }),
		]);
		expect(all.every((d) => d.p50 === 0 && d.p95 === 0 && d.p99 === 0)).toBe(true);
	});

	it("buckets to 0.5s, last-write-wins, sorted", () => {
		const data = buildPercentileChartData([
			tick({ elapsed_seconds: 1.1, latency_p99_ms: 80 }),
			tick({ elapsed_seconds: 1.2, latency_p99_ms: 90 }),
			tick({ elapsed_seconds: 0.6, latency_p99_ms: 30 }),
		]);
		expect(data.map((d) => d.time)).toEqual([0.5, 1.0]);
		expect(data[1].p99).toBe(90);
	});
});
