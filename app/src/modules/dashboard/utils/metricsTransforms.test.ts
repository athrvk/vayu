import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	isRateLimitedRun,
	buildLatencyChartData,
	buildRampOverlay,
	buildPercentileChartData,
	buildStatusOverTime,
	buildCustomMetricsOverTime,
	customMetricNames,
	customMetricSeriesLabel,
	hasPercentileSignal,
	hasStatusCodes,
	hasCustomMetrics,
	latestThroughputMbps,
	spansMultipleBuckets,
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
		// 450 - a 9x overshoot. A deficit-only formula clamps this to 0%; the
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

/*
 * The chart cards' render gates. Each one used to build the whole series and
 * read its length, so these prove the cheap predicate answers exactly what the
 * discarded series answered - anything less and a card appears or disappears at
 * a different moment than before.
 */
describe("spansMultipleBuckets", () => {
	it("agrees with the built series' length over randomized histories", () => {
		const rng = seeded(20260901);
		let sawTrue = 0;
		let sawFalse = 0;
		for (let run = 0; run < 200; run++) {
			const history = randomHistory(rng);
			const spans = spansMultipleBuckets(history);
			expect(spans).toBe(buildLatencyChartData(history).length > 1);
			expect(spans).toBe(buildPercentileChartData(history).length > 1);
			expect(spansMultipleBuckets(history, hasStatusCodes)).toBe(
				buildStatusOverTime(history).length > 1
			);
			if (spans) sawTrue++;
			else sawFalse++;
		}
		// The agreement above is worthless if every case landed on one side.
		expect(sawTrue).toBeGreaterThan(20);
		expect(sawFalse).toBeGreaterThan(20);
	});

	it("is false for ticks that share one 0.5s bucket, true once one leaves it", () => {
		const sameBucket = [tick({ elapsed_seconds: 1.0 }), tick({ elapsed_seconds: 1.1 })];
		expect(spansMultipleBuckets(sameBucket)).toBe(false);
		expect(buildLatencyChartData(sameBucket)).toHaveLength(1);

		const twoBuckets = [...sameBucket, tick({ elapsed_seconds: 1.4 })];
		expect(spansMultipleBuckets(twoBuckets)).toBe(true);
		expect(buildLatencyChartData(twoBuckets)).toHaveLength(2);
	});

	it("is false for an empty or single-tick history", () => {
		expect(spansMultipleBuckets([])).toBe(false);
		expect(spansMultipleBuckets([tick({ elapsed_seconds: 3 })])).toBe(false);
	});

	it("counts only the ticks `include` accepts", () => {
		const history = [
			tick({ elapsed_seconds: 1, status_codes: { "200": 5 } }),
			tick({ elapsed_seconds: 2 }),
			tick({ elapsed_seconds: 3 }),
		];
		// Three buckets, but only one tick carries the status map the stacked
		// chart reads - the same tick `buildStatusOverTime` keeps.
		expect(spansMultipleBuckets(history)).toBe(true);
		expect(spansMultipleBuckets(history, hasStatusCodes)).toBe(false);
		expect(buildStatusOverTime(history)).toHaveLength(1);
	});
});

describe("hasPercentileSignal", () => {
	it("is true when any tick reports a p99 above zero", () => {
		expect(hasPercentileSignal([tick({ elapsed_seconds: 1, latency_p99_ms: 12 })])).toBe(true);
		expect(hasPercentileSignal([tick({ elapsed_seconds: 1, latency_p99_ms: 0 })])).toBe(false);
		expect(hasPercentileSignal([])).toBe(false);
	});

	it("agrees with the built series wherever a bucket's last tick carries the signal", () => {
		const rng = seeded(4242);
		let sawTrue = 0;
		for (let run = 0; run < 200; run++) {
			const history = randomHistory(rng);
			const built = buildPercentileChartData(history).some((p) => p.p99 > 0);
			if (built) {
				// Documented direction: the predicate reads every tick, so it is
				// true wherever the built series is, and may be true when a
				// bucket's final tick alone reported nothing.
				expect(hasPercentileSignal(history)).toBe(true);
				sawTrue++;
			}
		}
		expect(sawTrue).toBeGreaterThan(20);
	});
});

describe("buildCustomMetricsOverTime", () => {
	it("uses p95 for a trend metric's series, not p50/p99/max", () => {
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: {
					latency: { type: "trend", count: 3, p50: 10, p95: 42, p99: 90, max: 120 },
				},
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.names).toEqual(["latency"]);
		expect(built.types).toEqual(["trend"]);
		expect(built.columns[0]).toEqual([42]);
	});

	// Mutation check: swapping p95 for p50 above must fail this case. It does -
	// `columns[0]` would read `[10]` instead of `[42]` - confirming the assertion
	// actually exercises the p95 choice rather than passing regardless.

	it("uses value for a counter or rate metric's series", () => {
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: {
					orders: { type: "counter", count: 5, value: 17 },
					cacheHitRate: { type: "rate", count: 5, value: 63.5 },
				},
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.names).toEqual(["cacheHitRate", "orders"]);
		expect(built.types).toEqual(["rate", "counter"]);
		expect(built.columns).toEqual([[63.5], [17]]);
	});

	it("gaps a name a tick's custom_metrics does not carry, rather than 0", () => {
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: { orders: { type: "counter", count: 1, value: 5 } },
			}),
			tick({
				elapsed_seconds: 2,
				custom_metrics: { latency: { type: "trend", count: 1, p95: 30 } },
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.names).toEqual(["latency", "orders"]);
		// latency: absent at t=1, recorded at t=2. orders: recorded at t=1, absent at t=2.
		expect(built.columns[built.names.indexOf("latency")]).toEqual([null, 30]);
		expect(built.columns[built.names.indexOf("orders")]).toEqual([5, null]);
	});

	it("gaps a trend tick that has recorded no completions yet, rather than 0", () => {
		// A trend with `count: 0` has no p95 to read (nothing completed in that
		// window) - the wire never sends a `p95` key at all for it, so this is
		// the "declared but not yet measured" case, distinct from "not declared".
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: { latency: { type: "trend", count: 0 } },
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.names).toEqual(["latency"]);
		expect(built.columns[0]).toEqual([null]);
	});

	it("tracks a counter that only increases, one running total per tick", () => {
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: { orders: { type: "counter", count: 1, value: 1 } },
			}),
			tick({
				elapsed_seconds: 2,
				custom_metrics: { orders: { type: "counter", count: 4, value: 4 } },
			}),
			tick({
				elapsed_seconds: 3,
				custom_metrics: { orders: { type: "counter", count: 9, value: 9 } },
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.columns[0]).toEqual([1, 4, 9]);
	});

	it("keeps a rate that never rose above 0% as real zeros, not gaps", () => {
		// `0` is a measured value here, not "not recorded" - `typeof value ===
		// "number"` must accept it rather than treating it as falsy.
		const history = [
			tick({
				elapsed_seconds: 1,
				custom_metrics: { cacheHitRate: { type: "rate", count: 5, value: 0 } },
			}),
			tick({
				elapsed_seconds: 2,
				custom_metrics: { cacheHitRate: { type: "rate", count: 9, value: 0 } },
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.columns[0]).toEqual([0, 0]);
	});

	it("returns no series when no tick carries custom_metrics", () => {
		const history = [tick({ elapsed_seconds: 1 }), tick({ elapsed_seconds: 2 })];
		const built = buildCustomMetricsOverTime(history);
		expect(built).toEqual({ times: [], names: [], types: [], columns: [] });
	});

	it("returns no series for an empty history, without throwing", () => {
		expect(buildCustomMetricsOverTime([])).toEqual({
			times: [],
			names: [],
			types: [],
			columns: [],
		});
	});

	it("buckets ticks to 0.5s, last tick in the bucket wins", () => {
		const history = [
			tick({
				elapsed_seconds: 1.0,
				custom_metrics: { orders: { type: "counter", count: 1, value: 1 } },
			}),
			tick({
				elapsed_seconds: 1.2,
				custom_metrics: { orders: { type: "counter", count: 2, value: 2 } },
			}),
		];
		const built = buildCustomMetricsOverTime(history);
		expect(built.times).toEqual([1]);
		expect(built.columns[0]).toEqual([2]);
	});
});

describe("customMetricNames", () => {
	it("is the sorted union of names across every tick", () => {
		const history = [
			tick({ elapsed_seconds: 1, custom_metrics: { zeta: { type: "counter", count: 1 } } }),
			tick({ elapsed_seconds: 2, custom_metrics: { alpha: { type: "rate", count: 1 } } }),
		];
		expect(customMetricNames(history)).toEqual(["alpha", "zeta"]);
	});

	it("is empty when no tick declares custom_metrics", () => {
		expect(customMetricNames([tick({ elapsed_seconds: 1 })])).toEqual([]);
	});
});

describe("hasCustomMetrics", () => {
	it("is true only for a tick with a non-empty custom_metrics map", () => {
		expect(
			hasCustomMetrics(tick({ custom_metrics: { orders: { type: "counter", count: 1 } } }))
		).toBe(true);
		expect(hasCustomMetrics(tick({ custom_metrics: {} }))).toBe(false);
		expect(hasCustomMetrics(tick({}))).toBe(false);
	});
});

describe("customMetricSeriesLabel", () => {
	it("suffixes a trend's label with its plotted stat", () => {
		expect(customMetricSeriesLabel("latency", "trend")).toBe("latency (p95)");
	});

	it("leaves a counter or rate's label plain", () => {
		expect(customMetricSeriesLabel("orders", "counter")).toBe("orders");
		expect(customMetricSeriesLabel("cacheHitRate", "rate")).toBe("cacheHitRate");
	});
});

/** Deterministic 0..1 generator - a fixed seed keeps a failure reproducible. */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/**
 * A history with the shapes the gates actually meet: empty, one tick, several
 * ticks inside one 0.5s bucket, ticks spanning buckets, ticks with and without
 * a status map, and p99 zero on some ticks (a tick with no completions).
 */
function randomHistory(rng: () => number): LoadTestMetrics[] {
	const n = Math.floor(rng() * 12);
	let elapsed = rng() * 2;
	return Array.from({ length: n }, () => {
		elapsed += rng() * 0.4; // often the same bucket, sometimes the next
		return tick({
			elapsed_seconds: Math.round(elapsed * 100) / 100,
			latency_p99_ms: rng() < 0.4 ? 0 : Math.round(rng() * 200),
			status_codes: rng() < 0.5 ? undefined : { "200": Math.floor(rng() * 100) },
		});
	});
}
