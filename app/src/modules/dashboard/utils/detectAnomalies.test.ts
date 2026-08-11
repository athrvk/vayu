/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The detector's whole value is that it stays quiet on a healthy run, so most of
 * what is pinned here is what it must NOT flag: a drifting baseline, a one-tick
 * blip, a cumulative failure count that stopped growing, a ramp winding down.
 * Each of those was a way an earlier rule would have filled a clean run with
 * events.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	detectAnomalies,
	BASELINE_TICKS,
	LATENCY_SPIKE_FACTOR,
	MIN_CONSECUTIVE_TICKS,
	MAX_ANOMALIES,
	ERROR_BURST_RATE,
	THROUGHPUT_DROP_FACTOR,
} from "./detectAnomalies";

function tick(elapsed: number, partial: Partial<LoadTestMetrics> = {}): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
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

/**
 * A healthy run: p99 drifts mildly upward, throughput and concurrency hold, and
 * nothing fails. The drift is deliberate - a flat series would pass the 3x rule
 * even if the factor were 1, so it could not tell a working threshold from a
 * broken one.
 */
function healthyRun(ticks: number, over: (i: number) => Partial<LoadTestMetrics> = () => ({})) {
	return Array.from({ length: ticks }, (_, i) =>
		tick(i, {
			latency_p99_ms: 100 + i,
			current_rps: 500,
			current_concurrency: 50,
			requests_completed: i * 500,
			requests_failed: 0,
			...over(i),
		})
	);
}

describe("detectAnomalies - a clean run", () => {
	it("finds nothing in a run that only drifts", () => {
		expect(detectAnomalies(healthyRun(60))).toEqual([]);
	});

	it("would flag that same run at a 1x factor - so the 3x threshold is what keeps it quiet", () => {
		/*
		 * The mutation check for the test above, run forwards. The clean series is
		 * clean only *because* of the factor: its drift puts consecutive ticks
		 * above the trailing median, which is a run of hot ticks the moment the
		 * factor is loosened to 1. A flat series would pass either way and so
		 * could not tell a working threshold from a broken one.
		 */
		const p99 = healthyRun(60).map((m) => m.latency_p99_ms);
		const trailingMedian = (i: number) =>
			[...p99.slice(i - BASELINE_TICKS, i)].sort((a, b) => a - b)[BASELINE_TICKS >> 1];

		for (const i of [30, 31]) {
			expect(p99[i]).toBeGreaterThan(trailingMedian(i) * 1);
			expect(p99[i]).toBeLessThan(trailingMedian(i) * LATENCY_SPIKE_FACTOR);
		}
	});

	it("finds nothing before a baseline exists, however wild the opening ticks are", () => {
		// Every run starts with connection setup and an empty histogram; without
		// the warmup requirement the first seconds of every run are an "anomaly".
		const opening = Array.from({ length: BASELINE_TICKS }, (_, i) =>
			tick(i, { latency_p99_ms: i % 2 === 0 ? 5 : 900, current_rps: 100 })
		);
		expect(detectAnomalies(opening)).toEqual([]);
	});

	it("finds nothing in a series too short to say anything about", () => {
		expect(detectAnomalies([])).toEqual([]);
		expect(detectAnomalies([tick(0, { latency_p99_ms: 5000 })])).toEqual([]);
	});
});

describe("detectAnomalies - latency spikes", () => {
	it("reports a two-tick 4x spike as one window with its bounds and magnitude", () => {
		const run = healthyRun(40, (i) => (i === 20 || i === 21 ? { latency_p99_ms: 480 } : {}));

		const found = detectAnomalies(run).filter((a) => a.kind === "latency_spike");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(20);
		// Ends at the last tick above the recovery factor - here the spike's own
		// second tick, since tick 22 is back at ~122ms against a ~113ms baseline.
		expect(found[0].endSeconds).toBe(21);
		// Baseline is the median of the 15 ticks before the spike (105…119 → 112),
		// frozen there rather than recomputed as the window extends.
		expect(found[0].magnitude).toBeCloseTo(480 / 112, 3);
		expect(found[0].label).toBe("p99 4.3x baseline for 1s");
	});

	it("does not report a one-tick spike", () => {
		// Mutation check: drop the MIN_CONSECUTIVE_TICKS requirement and this
		// single 4x tick becomes a window, which is the noise the rule exists to
		// suppress.
		expect(MIN_CONSECUTIVE_TICKS).toBe(2);
		const run = healthyRun(40, (i) => (i === 20 ? { latency_p99_ms: 480 } : {}));

		expect(detectAnomalies(run).filter((a) => a.kind === "latency_spike")).toEqual([]);
	});

	it("keeps a window open through a slow recovery instead of closing it at 3x", () => {
		// Ticks 20-21 open above 3x; 22-24 sit at ~2x, still degraded. One window,
		// not one window and three unreported seconds.
		const run = healthyRun(40, (i) =>
			i >= 20 && i <= 21
				? { latency_p99_ms: 480 }
				: i >= 22 && i <= 24
					? { latency_p99_ms: 230 }
					: {}
		);

		const found = detectAnomalies(run).filter((a) => a.kind === "latency_spike");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(20);
		expect(found[0].endSeconds).toBe(24);
	});
});

describe("detectAnomalies - error bursts", () => {
	it("reads the cumulative failure counter as a rate, not as a level", () => {
		// 500 failures happened once, early; the counter carries them for the rest
		// of the run. Reading it undiffed reports every later tick as failing.
		const run = healthyRun(40, (i) => ({ requests_failed: i === 0 ? 0 : 500 }));

		expect(detectAnomalies(run).filter((a) => a.kind === "error_burst")).toEqual([]);
	});

	it("reports a burst that exceeds the threshold for two consecutive ticks", () => {
		expect(ERROR_BURST_RATE).toBe(0.01);
		// 25 of each tick's 500 completions fail across ticks 10 and 11 - 5%.
		const run = healthyRun(40, (i) => ({
			requests_failed: i < 10 ? 0 : i === 10 ? 25 : 50,
		}));

		const found = detectAnomalies(run).filter((a) => a.kind === "error_burst");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(10);
		expect(found[0].endSeconds).toBe(11);
		expect(found[0].magnitude).toBeCloseTo(5, 1);
		expect(found[0].label).toMatch(/errors 5\.0% of requests for 1s/);
	});
});

describe("detectAnomalies - throughput drops", () => {
	it("reports a sustained drop while concurrency held", () => {
		const run = healthyRun(40, (i) => (i >= 25 && i <= 27 ? { current_rps: 200 } : {}));

		const found = detectAnomalies(run).filter((a) => a.kind === "throughput_drop");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(25);
		expect(found[0].endSeconds).toBe(27);
		expect(found[0].label).toMatch(/throughput 40% of baseline for 2s/);
	});

	it("does not report a ramp winding down, where concurrency fell with it", () => {
		// The load was reduced; producing less throughput is the run obeying, not
		// the target failing. Without the concurrency guard every ramp_up run's
		// tail would be an anomaly.
		expect(THROUGHPUT_DROP_FACTOR).toBe(0.6);
		const run = healthyRun(40, (i) =>
			i >= 25 ? { current_rps: 200, current_concurrency: 10 } : {}
		);

		expect(detectAnomalies(run).filter((a) => a.kind === "throughput_drop")).toEqual([]);
	});
});

describe("detectAnomalies - first 5xx", () => {
	it("marks the tick the first server error appeared on, once", () => {
		const run = healthyRun(40, (i) =>
			i >= 12 ? { status_codes: { "200": i * 490, "503": (i - 11) * 10 } } : {}
		);

		const found = detectAnomalies(run).filter((a) => a.kind === "first_5xx");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(12);
		expect(found[0].endSeconds).toBe(12);
		expect(found[0].label).toBe("first 503 response");
	});

	it("ignores a status map that carries only non-5xx codes", () => {
		const run = healthyRun(40, () => ({ status_codes: { "200": 1000, "404": 12 } }));

		expect(detectAnomalies(run).filter((a) => a.kind === "first_5xx")).toEqual([]);
	});
});

describe("detectAnomalies - the cap", () => {
	it("keeps the largest and says how many it dropped", () => {
		// 30 separate two-tick spikes of growing size, so which ones survive is
		// unambiguous.
		const spikes = 30;
		const run = healthyRun(BASELINE_TICKS + spikes * 5, (i) => {
			const nth = Math.floor((i - BASELINE_TICKS) / 5);
			const offset = (i - BASELINE_TICKS) % 5;
			if (i < BASELINE_TICKS || offset > 1) return {};
			return { latency_p99_ms: 500 + nth * 100 };
		});

		const found = detectAnomalies(run);
		expect(found).toHaveLength(MAX_ANOMALIES);
		// Spikes grow with time, so "the largest survive" is checkable by clock:
		// the ten dropped windows are the first ten, and the eleventh (at
		// BASELINE_TICKS + 10 * 5 seconds) is the earliest kept.
		expect(Math.min(...found.map((a) => a.startSeconds))).toBe(BASELINE_TICKS + 50);
		expect(found[found.length - 1].label).toMatch(/\(\+10 more\)$/);
		// Still in time order after the triage, so the list reads as a timeline.
		const times = found.map((a) => a.startSeconds);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});
});
