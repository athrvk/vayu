/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scales and axes `UPlotChart` hands uPlot, read back off the real plot: the
 * zero base (and its opt-out), the rebuild a changed base forces, and the
 * secondary axis' label.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";

const instances = vi.hoisted(() => ({ all: [] as uPlot[] }));
vi.mock("uplot", async (importOriginal) => {
	const actual = (await importOriginal()) as { default: new (...args: unknown[]) => uPlot };
	class TrackedUPlot extends actual.default {
		constructor(...args: unknown[]) {
			super(...args);
			instances.all.push(this as unknown as uPlot);
		}
	}
	return { ...actual, default: TrackedUPlot };
});

const last = () => instances.all[instances.all.length - 1];

const wobble: uPlot.AlignedData = [
	[0, 1, 2, 3],
	[480, 510, 495, 520],
];
const negative: uPlot.AlignedData = [
	[0, 1, 2, 3],
	[-40, -10, -25, -5],
];
const rps: UPlotSeriesSpec[] = [{ label: "rps", role: "categorical" }];
const ramp: UPlotSeriesSpec[] = [
	{ label: "rps", role: "categorical" },
	{ label: "users", role: "info", scale: "y2" },
];
const rampData: uPlot.AlignedData = [
	[0, 1, 2, 3],
	[480, 510, 495, 520],
	[10, 20, 30, 40],
];

/** uPlot commits a new data range in a microtask, so scales are read after one. */
const settled = () => act(async () => {});

beforeEach(() => {
	instances.all.length = 0;
});

describe("UPlotChart - y base", () => {
	it("starts the y scale at zero by default, so a wobble around 500 does not fill the plot", async () => {
		render(<UPlotChart data={wobble} series={rps} />);
		await settled();
		expect(last().scales.y.min).toBe(0);
		expect(last().scales.y.max).toBeGreaterThan(520);
	});

	it("keeps uPlot's auto-range when the base is null, so negative values are not clipped", async () => {
		render(<UPlotChart data={negative} series={rps} yMin={null} />);
		await settled();
		expect(last().scales.y.min).toBeLessThan(-40);
		expect(last().scales.y.max).toBeLessThan(5);
	});

	it("still shows data that falls below the base", async () => {
		render(<UPlotChart data={negative} series={rps} />);
		await settled();
		expect(last().scales.y.min).toBeLessThan(-40);
	});

	it("starts the secondary scale at the base too", async () => {
		render(<UPlotChart data={rampData} series={ramp} />);
		await settled();
		expect(last().scales.y2.min).toBe(0);
	});

	it("rebuilds the plot when the base changes, rather than ignoring it", async () => {
		const { rerender } = render(<UPlotChart data={wobble} series={rps} yMin={0} />);
		expect(instances.all).toHaveLength(1);
		rerender(<UPlotChart data={wobble} series={rps} yMin={0} />);
		expect(instances.all).toHaveLength(1);
		rerender(<UPlotChart data={wobble} series={rps} yMin={null} />);
		await settled();
		expect(instances.all).toHaveLength(2);
		expect(last().scales.y.min).toBeGreaterThan(400);
	});
});

describe("UPlotChart - secondary axis label", () => {
	const y2Axis = () => last().axes.find((a) => a.scale === "y2");

	it("labels the right-hand axis when given a label", async () => {
		render(<UPlotChart data={rampData} series={ramp} y2Label="Virtual users" />);
		expect(y2Axis()?.label).toBe("Virtual users");
	});

	it("leaves the axis unlabelled otherwise", async () => {
		render(<UPlotChart data={rampData} series={ramp} />);
		expect(y2Axis()).toBeDefined();
		expect(y2Axis()?.label).toBeUndefined();
	});

	it("rebuilds the plot when the label changes", async () => {
		const { rerender } = render(<UPlotChart data={rampData} series={ramp} />);
		rerender(<UPlotChart data={rampData} series={ramp} y2Label="Virtual users" />);
		expect(instances.all).toHaveLength(2);
		expect(y2Axis()?.label).toBe("Virtual users");
	});
});

describe("UPlotChart - isolated readings", () => {
	// The indices uPlot would draw a marker at for series 1, read off the real plot.
	const markedIndices = (values: (number | null)[]): number[] | null => {
		const xs = values.map((_, i) => i);
		render(<UPlotChart data={[xs, values]} series={rps} />);
		const plot = last();
		const points = plot.series[1].points;
		return typeof points?.filter === "function" ? points.filter(plot, 1, false) : null;
	};

	it("marks a reading whose neighbours are both gaps, which a line cannot draw", () => {
		expect(markedIndices([null, 301, null, 302, null])).toEqual([1, 3]);
	});

	it("marks nothing on a continuous series", () => {
		expect(markedIndices([1, 2, 3])).toBeNull();
	});

	it("marks nothing on a reading that has a neighbour, as the line reaches it", () => {
		expect(markedIndices([null, 5, 6, null, 7, 8])).toBeNull();
	});

	it("treats a data end as a gap", () => {
		expect(markedIndices([301, null, 302, 303, null, 304])).toEqual([0, 5]);
	});

	it("keeps a scatter series' own points", () => {
		render(
			<UPlotChart
				data={[
					[0, 1, 2],
					[4, 5, 6],
				]}
				series={[{ ...rps[0], kind: "scatter" }]}
			/>
		);
		const plot = last();
		const show = plot.series[1].points?.show;
		expect(typeof show === "function" && show(plot, 1, 0, 2)).toBe(true);
	});
});

describe("UPlotChart - annotation hover", () => {
	const hoverRows = (seconds: number): string[] => {
		const plot = last();
		plot.setCursor({ left: Math.round(plot.valToPos(seconds, "x")), top: 5 });
		const tip = plot.over.querySelector(".vayu-chart-tooltip") as HTMLElement;
		return Array.from(tip.children, (row) => row.textContent ?? "");
	};
	const spike = {
		startSeconds: 1,
		endSeconds: 2,
		label: "p99 spike",
		role: "warning" as const,
	};

	it("names the annotation under the cursor in the tooltip", async () => {
		render(<UPlotChart data={wobble} series={rps} xTime annotations={[spike]} />);
		await settled();
		expect(hoverRows(1)).toContain("p99 spike");
		expect(hoverRows(3)).not.toContain("p99 spike");
	});

	it("follows annotations that arrive later, with no rebuild of the plot", async () => {
		const { rerender } = render(
			<UPlotChart data={wobble} series={rps} xTime annotations={[]} />
		);
		await settled();
		rerender(<UPlotChart data={wobble} series={rps} xTime annotations={[spike]} />);
		await settled();
		expect(instances.all).toHaveLength(1);
		expect(hoverRows(1)).toContain("p99 spike");
	});
});
