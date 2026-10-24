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
 * The HDR percentile plot's x axis, read back off the real uPlot axis: each
 * labelled percentile prints once, at its own position (#2859). The old
 * nearest-percentile relabelling printed one label on several adjacent ticks.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { RunReport } from "@/types";
import { HdrPercentileChart } from "./ScatterAndDistribution";
import { pctToX } from "./hdrMarkers";

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

const report = {
	latency: { min: 5, avg: 25, p50: 20, p75: 30, p90: 45, p95: 60, p99: 120, p999: 200, max: 240 },
} as RunReport;

beforeEach(() => {
	instances.all.length = 0;
});

describe("HdrPercentileChart - x axis", () => {
	it("prints each percentile label once, at that percentile's position", async () => {
		render(<HdrPercentileChart report={report} />);
		// uPlot commits the scale range in a microtask; the axis reads it.
		await act(async () => {});
		const plot = instances.all[instances.all.length - 1];
		const axis = plot.axes[0];
		const splits = (axis.splits as (u: uPlot) => number[])(plot);
		const labels = (axis.values as (u: uPlot, sp: number[]) => string[])(plot, splits);

		expect(labels).toEqual(["0%", "50%", "90%", "95%", "99%", "99.9%"]);
		expect(splits).toEqual([0, 50, 90, 95, 99, 99.9].map(pctToX));
	});
});
