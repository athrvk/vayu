/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics, MonitorSample } from "@/types";
import { joinMonitorToTimeline, monitorSeriesNames, stalenessWindowMs } from "./monitorSeries";

function tick(timestamp: number, elapsed: number): LoadTestMetrics {
	return {
		timestamp,
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
	};
}

function sample(timestamp: number, series: Record<string, number>): MonitorSample {
	return { timestamp, series };
}

describe("monitorSeriesNames", () => {
	it("unions the names across samples, sorted", () => {
		expect(monitorSeriesNames([sample(1, { rss: 1 }), sample(2, { cpu: 2, rss: 3 })])).toEqual([
			"cpu",
			"rss",
		]);
	});

	it("is empty for no samples", () => {
		expect(monitorSeriesNames([])).toEqual([]);
	});
});

describe("stalenessWindowMs", () => {
	it("scales with the observed scrape cadence", () => {
		const scraped5s = [0, 5000, 10000, 15000].map((t) => sample(t, { cpu: 1 }));
		expect(stalenessWindowMs(scraped5s)).toBe(12500);
	});

	it("floors at 2s so a fast cadence still bridges one tick", () => {
		const scraped250ms = [0, 250, 500].map((t) => sample(t, { cpu: 1 }));
		expect(stalenessWindowMs(scraped250ms)).toBe(2000);
	});
});

describe("joinMonitorToTimeline", () => {
	it("is empty when either side has nothing", () => {
		expect(joinMonitorToTimeline([], [sample(1, { cpu: 1 })]).times).toEqual([]);
		expect(joinMonitorToTimeline([tick(1000, 0)], []).times).toEqual([]);
	});

	it("holds each reading across the ticks it covers", () => {
		// Scraped every 2s, ticked every 1s: the reading stands for the tick it
		// landed on and the one after it, which is what makes the line continuous
		// rather than every-other-point.
		const history = [0, 1, 2, 3].map((i) => tick(10_000 + i * 1000, i));
		const samples = [sample(10_000, { cpu: 10 }), sample(12_000, { cpu: 30 })];

		const joined = joinMonitorToTimeline(history, samples);
		expect(joined.names).toEqual(["cpu"]);
		expect(joined.times).toEqual([0, 1, 2, 3]);
		expect(joined.columns[0]).toEqual([10, 10, 30, 30]);
	});

	it("leaves ticks before the first scrape null rather than back-filling", () => {
		const history = [0, 1, 2].map((i) => tick(10_000 + i * 1000, i));
		const samples = [sample(12_000, { cpu: 30 })];

		expect(joinMonitorToTimeline(history, samples).columns[0]).toEqual([null, null, 30]);
	});

	it("breaks the line where the scrape stopped answering", () => {
		// A 5s cadence against 1s ticks, then a 25s hole. The reading has to
		// carry across the cadence (or the line is four-fifths gaps) and stop
		// carrying across the outage (or a flat line covers exactly the window
		// the overlay exists to expose). The window is derived from the observed
		// cadence, so both fall out of one rule.
		const history = Array.from({ length: 40 }, (_, i) => tick(10_000 + i * 1000, i));
		const samples = [
			sample(10_000, { cpu: 10 }),
			sample(15_000, { cpu: 12 }),
			sample(20_000, { cpu: 14 }),
			sample(45_000, { cpu: 20 }),
		];

		const column = joinMonitorToTimeline(history, samples).columns[0];
		expect(column[0]).toBe(10); // t=10000, its own reading
		expect(column[4]).toBe(10); // t=14000, held across the 5s cadence
		expect(column[10]).toBe(14); // t=20000, the next reading
		expect(column[25]).toBeNull(); // t=35000, well past any real cadence
		expect(column[34]).toBeNull(); // ...and still null in the hole
		expect(column[35]).toBe(20); // t=45000, the scrape came back
	});

	it("joins uneven cadences without reordering the columns", () => {
		const history = [0, 1, 2].map((i) => tick(1000 + i * 1000, i));
		const samples = [sample(2500, { rss: 200, cpu: 2 }), sample(900, { cpu: 1, rss: 100 })];

		const joined = joinMonitorToTimeline(history, samples);
		expect(joined.names).toEqual(["cpu", "rss"]);
		expect(joined.columns[0]).toEqual([1, 1, 2]);
		expect(joined.columns[1]).toEqual([100, 100, 200]);
	});

	it("nulls a name a scrape did not carry instead of holding a stale one", () => {
		// The engine omits a series the target stopped exporting; a chart that
		// carried the previous value forward would claim a reading that was
		// never taken.
		const history = [0, 1].map((i) => tick(1000 + i * 1000, i));
		const samples = [sample(1000, { cpu: 1, rss: 100 }), sample(2000, { cpu: 2 })];

		const joined = joinMonitorToTimeline(history, samples);
		expect(joined.columns[0]).toEqual([1, 2]);
		expect(joined.columns[1]).toEqual([100, null]);
	});
});
