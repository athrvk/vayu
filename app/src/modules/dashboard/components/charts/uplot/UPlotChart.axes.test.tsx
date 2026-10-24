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
 * zero base (and its opt-out), the rebuild a changed base forces, the
 * secondary axis' label, and the whole-number ticks of a count axis.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { UPlotChart, type UPlotSeriesSpec } from "./UPlotChart";
import { axisCount } from "./formatters";
import { WHOLE_NUMBER_TICKS } from "./wholeNumberTicks";

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

/** The ticks and labels uPlot drew for the axis on `scale`. */
function drawnAxis(scale: "y" | "y2"): { splits: number[]; labels: string[] } {
	const plot = last();
	const idx = plot.axes.findIndex((a) => a.scale === scale);
	const axis = plot.axes[idx] as uPlot.Axis & { _splits?: number[] };
	const splits = axis._splits ?? [];
	const values = axis.values as (u: uPlot, sp: number[], i: number) => string[];
	return { splits, labels: values(plot, splits, idx) };
}

const countsUpTo = (max: number): uPlot.AlignedData => [
	[0, 1, 2, 3],
	[0, max / 2, max, max / 2],
];
const countSeries: UPlotSeriesSpec[] = [{ label: "in flight", role: "info" }];

describe("UPlotChart - whole-number ticks", () => {
	const renderCount = async (max: number) => {
		render(
			<UPlotChart
				data={countsUpTo(max)}
				series={countSeries}
				yFormat={axisCount}
				wholeNumberScales={["y"]}
			/>
		);
		await settled();
		return drawnAxis("y");
	};

	it.each([1, 2, 10, 13])(
		"ticks a maximum of %i on whole numbers with distinct labels",
		async (max) => {
			const { splits, labels } = await renderCount(max);
			expect(splits.length).toBeGreaterThan(1);
			expect(splits.every(Number.isInteger)).toBe(true);
			expect(labels).toEqual(splits.map(String));
			expect(new Set(labels).size).toBe(labels.length);
			const { min, max: top } = last().scales.y;
			expect(splits.every((v) => v >= min! && v <= top!)).toBe(true);
		}
	);

	it("ticks 0, 1 and 2 for a maximum of 2, not 0, 0.5, 1, 1.5, 2", async () => {
		const { splits } = await renderCount(2);
		expect(splits).toEqual([0, 1, 2]);
	});

	it("ticks 0 and 1 for a maximum of 1", async () => {
		const { splits } = await renderCount(1);
		expect(splits).toEqual([0, 1]);
	});

	it("keeps a fractional maximum as the one extra tick under a span of 1, labelled in full", async () => {
		const { splits, labels } = await renderCount(0.4);
		expect(splits).toEqual([0, last().scales.y.max]);
		expect(labels[0]).toBe("0");
		expect(Number(labels[1])).not.toBe(0);
		expect(new Set(labels).size).toBe(2);
	});

	it("applies to the secondary axis alone when only that scale opts in", async () => {
		const data: uPlot.AlignedData = [
			[0, 1, 2, 3],
			[480, 510, 495, 520],
			[0, 1, 2, 1],
		];
		render(
			<UPlotChart data={data} series={ramp} y2Format={axisCount} wholeNumberScales={["y2"]} />
		);
		await settled();
		expect(drawnAxis("y2").splits.every(Number.isInteger)).toBe(true);
		expect(drawnAxis("y2").splits).toEqual([0, 1, 2]);
		expect(last().axes.find((a) => a.scale === "y")?.splits).not.toBe(
			WHOLE_NUMBER_TICKS.splits
		);
	});

	it("leaves a chart that does not opt in on uPlot's own spacing", async () => {
		render(<UPlotChart data={countsUpTo(2)} series={countSeries} />);
		await settled();
		const axis = last().axes.find((a) => a.scale === "y");
		expect(axis?.splits).not.toBe(WHOLE_NUMBER_TICKS.splits);
		expect(drawnAxis("y").splits).toContain(0.5);
	});

	it("rebuilds the plot when the opt-in changes", async () => {
		const { rerender } = render(<UPlotChart data={countsUpTo(2)} series={countSeries} />);
		rerender(
			<UPlotChart data={countsUpTo(2)} series={countSeries} wholeNumberScales={["y"]} />
		);
		await settled();
		expect(instances.all).toHaveLength(2);
		expect(drawnAxis("y").splits).toEqual([0, 1, 2]);
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
