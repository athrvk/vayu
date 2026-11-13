/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The words a screen reader gets for a chart (#3498): the title, then the
 * latest, lowest and highest reading of each series the tooltip shows.
 */

import type uPlot from "uplot";
import { describe, it, expect } from "vitest";
import { describeChart } from "./chartLabel";
import { fmtMs } from "./formatters";
import type { UPlotSeriesSpec } from "./UPlotChart";

const ms = (label: string, extra: Partial<UPlotSeriesSpec> = {}): UPlotSeriesSpec => ({
	label,
	role: "categorical",
	format: fmtMs,
	...extra,
});

describe("describeChart", () => {
	it("names the latest, lowest and highest reading of each series", () => {
		const data: uPlot.AlignedData = [
			[0, 1, 2],
			[12, 8, 10],
			[30, 40, 20],
		];

		expect(describeChart("Latency over time", data, [ms("p50"), ms("p99")])).toBe(
			"Latency over time. p50: latest 10ms, lowest 8ms, highest 12ms. p99: latest 20ms, lowest 20ms, highest 40ms"
		);
	});

	it("skips gaps, and a series with no reading at all", () => {
		const data: uPlot.AlignedData = [
			[0, 1, 2, 3],
			[null, 5, null, 7],
			[null, null, null, null],
		];

		const label = describeChart("Vitals", data, [ms("cpu"), ms("queue")]);

		expect(label).toContain("cpu: latest 7ms, lowest 5ms, highest 7ms");
		expect(label).not.toContain("queue");
	});

	it("leaves out a series the tooltip hides", () => {
		const data: uPlot.AlignedData = [
			[0, 1],
			[1, 2],
			[1, 2],
		];

		const label = describeChart("Runs", data, [ms("p95"), ms("p95", { hideInTooltip: true })]);

		expect(label.match(/p95:/g)).toHaveLength(1);
	});

	it("reads a stacked series by its own values, not the running total", () => {
		const data: uPlot.AlignedData = [
			[0, 1],
			[10, 10],
			[14, 15],
		];
		const stacked = ms("4xx", { tipValues: [4, 5] });

		const label = describeChart("Status codes", data, [ms("2xx"), stacked]);

		expect(label).toContain("4xx: latest 5ms, lowest 4ms, highest 5ms");
		expect(label).not.toContain("15ms");
	});

	it("falls back to a plain figure when a series has no formatter", () => {
		const data: uPlot.AlignedData = [
			[0, 1],
			[1.5, 2.25],
		];

		expect(describeChart("Plain", data, [{ label: "n", role: "info" }])).toBe(
			"Plain. n: latest 2.25, lowest 1.5, highest 2.25"
		);
	});

	it("speaks a sub-resolution figure in words, and is just the title for an empty chart", () => {
		const data: uPlot.AlignedData = [
			[0, 1],
			[0.001, 0.002],
		];

		expect(describeChart("Tiny", data, [ms("p50")])).toContain("latest less than 0.01ms");
		expect(describeChart("Empty", [[], []], [ms("p50")])).toBe("Empty");
	});
});
