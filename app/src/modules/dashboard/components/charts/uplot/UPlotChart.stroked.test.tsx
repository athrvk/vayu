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
 * `UPlotSeriesSpec.stroked`, read off the paths the real plot builds: `false`
 * drops the line and nothing else, so a zero-height band stays a band.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
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

const data: uPlot.AlignedData = [
	[0, 1, 2],
	[1, 2, 3],
	[2, 3, 4],
	[3, 4, 5],
];

/**
 * Three stacked areas, each band filled down to the one below; `mid` is the
 * upper edge of one band and the lower edge of the next.
 */
function stack(mid: Partial<UPlotSeriesSpec>): UPlotSeriesSpec[] {
	return [
		{ label: "base", role: "categorical", kind: "area" },
		{ label: "mid", role: "categorical", kind: "area", bandTo: 1, ...mid },
		{ label: "top", role: "categorical", kind: "area", bandTo: 2 },
	];
}

/** The paths the latest plot builds for its `mid` series, as which parts it has. */
function midParts(): Record<"stroke" | "fill" | "band", boolean> {
	const plot = instances.all[instances.all.length - 1];
	const built = plot.series[2].paths?.(plot, 2, 0, data[0].length - 1);
	return {
		stroke: Boolean(built?.stroke),
		fill: Boolean(built?.fill),
		band: Boolean(built?.band),
	};
}

function renderMid(mid: Partial<UPlotSeriesSpec>) {
	const { unmount } = render(<UPlotChart data={data} series={stack(mid)} />);
	const parts = midParts();
	unmount();
	return parts;
}

beforeEach(() => {
	instances.all.length = 0;
});

describe("UPlotChart - stroked", () => {
	it("keeps the line of a series with `stroked` unset or true", () => {
		expect(renderMid({}).stroke).toBe(true);
		expect(renderMid({ stroked: true }).stroke).toBe(true);
	});

	it("drops the line of a `stroked: false` series and keeps its fill and band", () => {
		const drawn = renderMid({});
		// Something to keep: the stroked twin's paths carry each part.
		expect(drawn).toEqual({ stroke: true, fill: true, band: true });
		expect(renderMid({ stroked: false })).toEqual({ ...drawn, stroke: false });
	});
});
