/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	bucketColumns,
	buildConcurrencyScatter,
	rebucket,
	pickThroughput,
	pickSendRate,
	hasSendRate,
	pickErrorRate,
} from "./buildData";
import { detectAnomalies } from "../../../utils/detectAnomalies";

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
			tick({ elapsed_seconds: 0.1, current_rps: 100 }), // → bucket 0.0
			tick({ elapsed_seconds: 0.3, current_rps: 110 }), // → bucket 0.5
			tick({ elapsed_seconds: 0.6, current_rps: 200 }), // → bucket 0.5 (wins)
			tick({ elapsed_seconds: 1.0, current_rps: 300 }), // → bucket 1.0
		];
		const { times, cols } = bucketColumns(history, [pickThroughput]);
		expect(times).toEqual([0, 0.5, 1]);
		expect(cols[0]).toEqual([100, 200, 300]);
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
			tick({ elapsed_seconds: 0.5, current_rps: 10 }), // → bucket 0
			tick({ elapsed_seconds: 1.5, current_rps: 20 }), // → bucket 2 (round(1.5/2)*2)
			tick({ elapsed_seconds: 3.4, current_rps: 30 }), // → bucket 4
		];
		const { times, cols } = bucketColumns(history, [pickThroughput], 2);
		expect(times).toEqual([0, 2, 4]);
		expect(cols[0]).toEqual([10, 20, 30]);
	});
});

/*
 * The throughput line is the engine's trailing-window rate, `current_rps`, and
 * never the run-cumulative `throughput`: a cumulative line lags a real step by
 * the run's age (#2393).
 */
describe("pickThroughput", () => {
	/** 1000 req/s for 30 s, then 200 req/s: the run-cumulative rate is still 780 ten seconds on. */
	function steppedDown(): LoadTestMetrics[] {
		let completed = 0;
		return Array.from({ length: 41 }, (_, t) => {
			const rate = t < 30 ? 1000 : 200;
			completed += t === 0 ? 0 : rate;
			return tick({
				elapsed_seconds: t,
				requests_completed: completed,
				current_rps: rate,
				throughput: t === 0 ? 0 : completed / t,
			});
		});
	}

	it("plots the stepped-down rate at t=40, not the cumulative 780", () => {
		const history = steppedDown();
		const atForty = history[40];
		// The fixture really does hold the cumulative figure the line must not use.
		expect(Math.round(atForty.throughput ?? 0)).toBe(780);

		const { times, cols } = bucketColumns(history, [pickThroughput]);
		expect(cols[0][times.indexOf(40)]).toBe(200);
		expect(cols[0][times.indexOf(29)]).toBe(1000);
	});

	it("reads 0 where the tick holds no current_rps, never the cumulative throughput", () => {
		const bare = {
			...tick({ throughput: 777 }),
			current_rps: undefined,
		} as unknown as LoadTestMetrics;
		expect(pickThroughput(bare)).toBe(0);
	});

	it("plots quantized ticks as the engine stored them, within 5% of the true rate on average", () => {
		// A closed-loop run completes in batches, so single ticks read 398, 498,
		// 499, 399 around a true 450. The line is the stored figure, untouched: no
		// resampling from the cumulative counters, which would bend it.
		const rates = [398, 498, 499, 399, 398, 498, 499, 399];
		const history = rates.map((r, i) =>
			tick({ elapsed_seconds: i + 1, current_rps: r, requests_completed: (i + 1) * 450 })
		);
		const { cols } = bucketColumns(history, [pickThroughput]);
		expect(cols[0]).toEqual(rates);
		const mean = cols[0].reduce((a, b) => a + b, 0) / cols[0].length;
		expect(Math.abs(mean - 450) / 450).toBeLessThanOrEqual(0.05);
	});
});

describe("pickSendRate and hasSendRate", () => {
	it("returns the tick's windowed send rate, a measured 0 included", () => {
		expect(pickSendRate(tick({ current_send_rate: 480 }))).toBe(480);
		expect(pickSendRate(tick({ current_send_rate: 0 }))).toBe(0);
	});

	it("returns null, not the cumulative send_rate, for a tick stored without one", () => {
		expect(pickSendRate(tick({ send_rate: 900 }))).toBeNull();
	});

	it("is true when any tick carries the figure, false when none does", () => {
		const bare = tick({ send_rate: 900 });
		expect(hasSendRate([bare, bare])).toBe(false);
		expect(hasSendRate([bare, tick({ current_send_rate: 0 })])).toBe(true);
		expect(hasSendRate([])).toBe(false);
	});

	it("buckets a tick without the figure as a gap beside the ticks that have it", () => {
		const history = [
			tick({ elapsed_seconds: 0, current_send_rate: 10 }),
			tick({ elapsed_seconds: 1 }),
			tick({ elapsed_seconds: 2, current_send_rate: 30 }),
		];
		const { cols } = bucketColumns(history, [pickSendRate]);
		expect(cols[0]).toEqual([10, null, 30]);
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

describe("rebucket with merge: max", () => {
	it("keeps the worst sample per column in a bucket, not the last", () => {
		// Five per-second p99s into one 5 s bucket, the tail second first.
		const times = [3, 4, 5, 6, 7];
		const p50 = [10, 11, 12, 13, 14];
		const p99 = [900, 40, 41, 42, 43];
		const { times: outT, cols } = rebucket(times, [p50, p99], 5, "max");
		expect(outT).toEqual([5]);
		expect(cols[0]).toEqual([14]);
		expect(cols[1]).toEqual([900]);
	});

	it("is last-wins unless asked, so other charts keep their behaviour", () => {
		const { cols } = rebucket([3, 4, 5, 6, 7], [[900, 40, 41, 42, 43]], 5);
		expect(cols[0]).toEqual([43]);
	});

	it("lets a reading win over a gap, never counting the gap as 0", () => {
		const { cols } = rebucket([3, 4, 5, 6], [[null, 40, null, null]], 5, "max");
		// 3→5 (null), 4→5 (40) then 5→5 (null) then 6→5 (null): the bucket keeps 40.
		expect(cols[0]).toEqual([40]);
		expect(rebucket([1, 2], [[null, null]], 2, "max").cols[0]).toEqual([null]);
		expect(rebucket([1, 2], [[-5, null]], 2, "max").cols[0]).toEqual([-5]);
	});

	it("never averages: a bucket of two seconds shows one of them", () => {
		const { cols } = rebucket([1, 2], [[100, 300]], 2, "max");
		expect(cols[0]).toEqual([300]);
	});
});

describe("buildConcurrencyScatter on a live series (issue #2385)", () => {
	it("plots the gate frames' second p99 and drops the frames between", () => {
		const live = (partial: Partial<LoadTestMetrics>) => tick({ live: true, ...partial });
		const history = [
			live({ elapsed_seconds: 0.5, current_concurrency: 5, latency_p99_ms: 777 }),
			live({
				elapsed_seconds: 1,
				current_concurrency: 10,
				latency_p99_ms: 1,
				second_samples: 100,
				second_p50_ms: 5,
				second_p95_ms: 8,
				second_p99_ms: 90,
			}),
			live({ elapsed_seconds: 1.5, current_concurrency: 11, latency_p99_ms: 777 }),
			live({
				elapsed_seconds: 2,
				current_concurrency: 20,
				second_samples: 0,
				second_p50_ms: null,
				second_p95_ms: null,
				second_p99_ms: null,
			}),
			live({
				elapsed_seconds: 3,
				current_concurrency: 30,
				second_samples: 100,
				second_p50_ms: 9,
				second_p95_ms: 30,
				second_p99_ms: 250,
			}),
		];
		const { concurrency, p99, times } = buildConcurrencyScatter(history);
		expect(concurrency).toEqual([10, 30]);
		expect(p99).toEqual([90, 250]);
		expect(times).toEqual([1, 3]);
	});
});

describe("buildConcurrencyScatter", () => {
	it("plots one point per bucket, not one per tick", () => {
		// A minute of the engine's 10Hz tick: 600 ticks over 0..59.9s, which
		// round-to-nearest collapses into the 121 half-second buckets 0..60.
		const history = Array.from({ length: 600 }, (_, i) =>
			tick({
				elapsed_seconds: i / 10,
				current_concurrency: 10 + i,
				latency_p99_ms: 50 + i,
			})
		);
		const { concurrency, p99, times } = buildConcurrencyScatter(history);
		expect(concurrency).toHaveLength(121);
		expect(p99).toHaveLength(121);
		expect(times).toHaveLength(121);
		// The point of the change: cost follows the bucket count, so a window
		// five times longer at the same tick rate is five times the dots, not
		// 3,000 of them for every flush of a 5-minute window.
		expect(concurrency.length).toBeLessThan(history.length / 4);
	});

	it("keeps the last sample in a bucket, so a ramp step's settled value survives", () => {
		const history = [
			tick({ elapsed_seconds: 0.1, current_concurrency: 10, latency_p99_ms: 90 }),
			// Same bucket as above (0.0), and the one that wins.
			tick({ elapsed_seconds: 0.2, current_concurrency: 12, latency_p99_ms: 95 }),
			tick({ elapsed_seconds: 0.6, current_concurrency: 20, latency_p99_ms: 140 }),
		];
		const { concurrency, p99, times } = buildConcurrencyScatter(history);
		expect(concurrency).toEqual([12, 20]);
		expect(p99).toEqual([95, 140]);
		expect(times).toEqual([0, 0.5]);
	});

	it("sorts by concurrency and carries each point's bucket time with it", () => {
		// Concurrency falling over time - uPlot needs x ascending, and a dot's
		// timestamp has to follow it into the sorted order or the focus channel
		// highlights the wrong moment.
		const history = [
			tick({ elapsed_seconds: 0, current_concurrency: 30, latency_p99_ms: 300 }),
			tick({ elapsed_seconds: 1, current_concurrency: 20, latency_p99_ms: 200 }),
			tick({ elapsed_seconds: 2, current_concurrency: 10, latency_p99_ms: 100 }),
		];
		const { concurrency, p99, times } = buildConcurrencyScatter(history);
		expect(concurrency).toEqual([10, 20, 30]);
		expect(p99).toEqual([100, 200, 300]);
		expect(times).toEqual([2, 1, 0]);
	});

	it("honours a wider bucket setting, and treats a missing p99 as zero", () => {
		const history = [
			tick({ elapsed_seconds: 0, current_concurrency: 5 }),
			tick({ elapsed_seconds: 0.9, current_concurrency: 8, latency_p99_ms: 40 }),
			tick({ elapsed_seconds: 2.0, current_concurrency: 9, latency_p99_ms: 60 }),
		];
		// 2s buckets: round(0/2)*2 = 0, round(0.9/2)*2 = 0, round(2/2)*2 = 2.
		const { concurrency, p99 } = buildConcurrencyScatter(history, 2);
		expect(concurrency).toEqual([8, 9]);
		expect(p99).toEqual([40, 60]);
	});

	it("returns empty columns for an empty history", () => {
		expect(buildConcurrencyScatter([])).toEqual({ concurrency: [], p99: [], times: [] });
	});
});

/*
 * One field, three readers (#2393): the throughput chart plots `current_rps`,
 * the anomaly detector reads `current_rps`, and the engine's HTML export draws
 * `current_rps` from the same stored ticks (`tick_points (ticks, "current_rps")`
 * in `engine/src/core/run_export_html.cpp`, a C++ file this suite cannot call,
 * so the name is recorded here, not enforced). A chart and a detector reading
 * different quantities is how a shaded window ended up over a line that showed
 * no drop.
 */
const EXPORT_THROUGHPUT_FIELD = "current_rps";

describe("the throughput series the chart, the detector and the export read", () => {
	function storedRun(): LoadTestMetrics[] {
		return Array.from({ length: 40 }, (_, t) =>
			tick({
				elapsed_seconds: t + 1,
				requests_completed: (t + 1) * 500,
				current_rps: t >= 25 && t <= 27 ? 200 : 500,
				// A cumulative figure the three readers must all ignore.
				throughput: 480,
				latency_p99_ms: 20,
				status_codes: { "200": (t + 1) * 500 },
			})
		);
	}

	it("agrees on current_rps, and the detector's throughput drop sits on the chart's dip", () => {
		const history = storedRun();
		const { times, cols } = bucketColumns(history, [pickThroughput]);
		// A comparison of two empty series passes; assert there is something to compare.
		expect(cols[0].length).toBeGreaterThan(20);

		// Chart column == the field the export draws, tick for tick.
		expect(cols[0]).toEqual(history.map((m) => m[EXPORT_THROUGHPUT_FIELD]));

		const drop = detectAnomalies(history).find((a) => a.kind === "throughput_drop");
		expect(drop).toBeDefined();
		const dipped = times.filter((_, i) => cols[0][i] === 200);
		expect(dipped.length).toBeGreaterThan(0);
		expect(drop!.startSeconds).toBeLessThanOrEqual(Math.min(...dipped));
		expect(drop!.endSeconds).toBeGreaterThanOrEqual(Math.max(...dipped));
	});
});
