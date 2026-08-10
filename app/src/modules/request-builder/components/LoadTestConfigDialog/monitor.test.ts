/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	buildMonitor,
	emptyMonitorDraft,
	monitorError,
	monitorSeriesList,
	type MonitorDraft,
} from "./monitor";

function draft(over: Partial<MonitorDraft> = {}): MonitorDraft {
	return { ...emptyMonitorDraft(), ...over };
}

describe("monitorError", () => {
	it("accepts an empty draft - monitoring is opt-in", () => {
		expect(monitorError(emptyMonitorDraft())).toBeNull();
		// ...and a series list typed then abandoned does not turn it on.
		expect(monitorError(draft({ series: "node_cpu_seconds_total" }))).toBeNull();
	});

	it("accepts a complete block", () => {
		expect(
			monitorError(
				draft({ url: "http://localhost:9100/metrics", series: "node_cpu_seconds_total" })
			)
		).toBeNull();
	});

	it("rejects a URL the engine could not fetch", () => {
		expect(monitorError(draft({ url: "localhost:9100/metrics", series: "up" }))).toMatch(
			/http:\/\//
		);
	});

	it("rejects an endpoint with nothing to read", () => {
		// The engine 400s a block with an empty `series`, so this must stop the
		// run here rather than after the dialog closes.
		expect(monitorError(draft({ url: "http://localhost:9100/metrics" }))).toMatch(
			/at least one metric/i
		);
	});

	it("rejects an interval outside the engine's range", () => {
		const base = { url: "http://localhost:9100/metrics", series: "up" };
		expect(monitorError(draft({ ...base, intervalMs: 100 }))).toMatch(/interval/i);
		expect(monitorError(draft({ ...base, intervalMs: 90_000 }))).toMatch(/interval/i);
		expect(monitorError(draft({ ...base, intervalMs: 250 }))).toBeNull();
	});

	it("rejects more series than the chart can carry", () => {
		const nine = Array.from({ length: 9 }, (_, i) => `m${i}`).join("\n");
		expect(monitorError(draft({ url: "http://localhost:9100/metrics", series: nine }))).toMatch(
			/at most 8/i
		);
	});
});

describe("monitorSeriesList", () => {
	it("drops blank lines and surrounding whitespace", () => {
		expect(monitorSeriesList(draft({ series: "  a  \n\n b\n\n" }))).toEqual(["a", "b"]);
	});
});

describe("buildMonitor", () => {
	it("is undefined without a URL, so the payload omits the block entirely", () => {
		expect(buildMonitor(emptyMonitorDraft())).toBeUndefined();
		expect(buildMonitor(draft({ series: "up" }))).toBeUndefined();
	});

	it("is undefined with a URL and no metrics rather than an empty series", () => {
		// The engine rejects `series: []`; sending it would fail the run instead
		// of starting one without monitoring.
		expect(buildMonitor(draft({ url: "http://localhost:9100/metrics" }))).toBeUndefined();
	});

	it("builds the engine's block, trimmed", () => {
		expect(
			buildMonitor(
				draft({
					url: "  http://localhost:9100/metrics  ",
					intervalMs: 2000,
					format: "json",
					series: "cpu\n rss ",
				})
			)
		).toEqual({
			url: "http://localhost:9100/metrics",
			intervalMs: 2000,
			format: "json",
			series: ["cpu", "rss"],
		});
	});
});
