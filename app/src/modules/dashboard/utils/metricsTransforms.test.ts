import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	isRateLimitedRun,
	buildLatencyChartData,
	buildRampOverlay,
	buildPercentileChartData,
	buildStatusOverTime,
	latestThroughputMbps,
} from "./metricsTransforms";

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
				tick({ elapsed_seconds: 15, current_concurrency: 90 }),
			],
			{ rampUpDurationSeconds: 10, startConcurrency: 0, targetConcurrency: 100 }
		)!;
		const at5 = overlay.points.find((p) => p.time === 5)!;
		expect(at5.configured).toBeCloseTo(50);
		expect(at5.achieved).toBe(40);
		const at15 = overlay.points.find((p) => p.time === 15)!;
		expect(at15.configured).toBe(100);
		expect(overlay.peakAchieved).toBe(90);
		expect(overlay.target).toBe(100);
	});

	it("near-perfect ramp yields a tiny two-sided deviation", () => {
		// achieved tracks the configured curve closely; deviation ~0.
		const overlay = buildRampOverlay(
			[
				tick({ elapsed_seconds: 5, current_concurrency: 50 }),
				tick({ elapsed_seconds: 10, current_concurrency: 100 }),
				tick({ elapsed_seconds: 15, current_concurrency: 100 }),
			],
			{ rampUpDurationSeconds: 10, startConcurrency: 0, targetConcurrency: 100 }
		)!;
		expect(overlay.rampDeviationPct).toBeCloseTo(0, 1);
	});

	it("counts overshoot, not just deficit (A3 regression)", () => {
		// At t=15 the configured curve is 50 (still ramping) but achieved is
		// 450 — a 9x overshoot. A deficit-only formula clamps this to 0%; the
		// two-sided deviation must surface it as a large number.
		const overlay = buildRampOverlay(
			[tick({ elapsed_seconds: 15, current_concurrency: 450 })],
			{ rampUpDurationSeconds: 30, startConcurrency: 0, targetConcurrency: 50 }
		)!;
		// |450 - 25| / 50 = 850%  (configured at t=15 over a 30s ramp to 50 = 25)
		expect(overlay.rampDeviationPct).toBeGreaterThan(100);
		expect(overlay.rampDeviationPct).toBeCloseTo(850, 0);
	});

	it("does not produce NaN/Inf when configured is 0 at t=0 (start=0)", () => {
		const overlay = buildRampOverlay(
			[
				tick({ elapsed_seconds: 0, current_concurrency: 0 }),
				tick({ elapsed_seconds: 5, current_concurrency: 50 }),
			],
			{ rampUpDurationSeconds: 10, startConcurrency: 0, targetConcurrency: 100 }
		)!;
		expect(Number.isFinite(overlay.rampDeviationPct)).toBe(true);
	});
});

describe("buildPercentileChartData", () => {
	it("buckets p50/p95/p99 per tick, sorted by time", () => {
		const data = buildPercentileChartData([
			tick({
				elapsed_seconds: 1,
				latency_p50_ms: 10,
				latency_p95_ms: 40,
				latency_p99_ms: 80,
			}),
			tick({
				elapsed_seconds: 2,
				latency_p50_ms: 12,
				latency_p95_ms: 60,
				latency_p99_ms: 150,
			}),
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

describe("buildStatusOverTime", () => {
	it("classifies and diffs cumulative status maps into per-interval counts", () => {
		const out = buildStatusOverTime([
			tick({ elapsed_seconds: 0.5, status_codes: { "200": 100, "404": 5 } }),
			tick({ elapsed_seconds: 1.0, status_codes: { "200": 180, "404": 7, "500": 3 } }),
		]);
		expect(out).toHaveLength(2);
		// First interval = cumulative-so-far; second = diff from first.
		expect(out[0]).toMatchObject({ time: 0.5, c2xx: 100, c4xx: 5, c5xx: 0 });
		expect(out[1]).toMatchObject({ time: 1.0, c2xx: 80, c4xx: 2, c5xx: 3 });
	});

	it("treats status code 0 as connection error and clamps diffs >= 0", () => {
		const out = buildStatusOverTime([
			tick({ elapsed_seconds: 0.5, status_codes: { "0": 4 } }),
			tick({ elapsed_seconds: 1.0, status_codes: { "0": 4 } }),
		]);
		expect(out[0].cErr).toBe(4);
		expect(out[1].cErr).toBe(0);
	});

	it("returns [] when no tick carries a status map", () => {
		expect(buildStatusOverTime([tick({ elapsed_seconds: 1 })])).toEqual([]);
	});
});

describe("latestThroughputMbps", () => {
	it("diffs the last two cumulative byte samples into MB/s", () => {
		const mbps = latestThroughputMbps([
			tick({ elapsed_seconds: 1, bytes_received: 1_000_000 }),
			tick({ elapsed_seconds: 2, bytes_received: 3_000_000 }),
		]);
		expect(mbps).toBeCloseTo(2.0); // 2 MB over 1s
	});

	it("returns 0 with fewer than two samples", () => {
		expect(latestThroughputMbps([tick({ bytes_received: 5 })])).toBe(0);
	});
});
