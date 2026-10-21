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
 * The status chart plots a running total so its bands stack, which made the
 * tooltip print the stack height on every row (a clean run read "2xx 9008,
 * 3xx 9008, ... err 9008", #2143). Driven through the real chart: render it,
 * move the cursor onto a bucket, read the tooltip.
 */

import type uPlot from "uplot";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import { StatusCodesOverTimeChart } from "./StatusCodesOverTimeChart";

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

function tick(elapsed: number, codes: Record<string, number>): LoadTestMetrics {
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
		status_codes: codes,
	};
}

/**
 * Cumulative status maps at the stored cadence, a second apart from elapsed 0;
 * `perTick` is each class' count in that second, so it is also its rate.
 */
function history(perTick: Record<string, number>[]): LoadTestMetrics[] {
	const total: Record<string, number> = {};
	return perTick.map((codes, i) => {
		for (const [code, n] of Object.entries(codes)) total[code] = (total[code] ?? 0) + n;
		return tick(i, { ...total });
	});
}

/** Hover bucket `idx` and return the tooltip's rows as "label value" strings. */
function hoverRows(idx: number): string[] {
	const plot = instances.all[instances.all.length - 1];
	// jsdom has no layout, so aim the cursor by the x value's pixel, not a bounding box.
	plot.setCursor({ left: Math.round(plot.valToPos(plot.data[0][idx] as number, "x")), top: 5 });
	const tip = plot.over.querySelector(".vayu-chart-tooltip") as HTMLElement;
	return Array.from(tip.children, (row) => row.textContent ?? "");
}

beforeEach(() => {
	instances.all.length = 0;
});

describe("StatusCodesOverTimeChart tooltip", () => {
	it("reads one line for a clean run: the 2xx rate, with the unit", () => {
		render(<StatusCodesOverTimeChart history={history([{ "200": 9000 }, { "200": 9000 }])} />);
		expect(hoverRows(1)).toEqual(["1.0s", "responses", "2xx9,000/s"]);
	});

	it("prints each present class' own rate, not the stack height", () => {
		render(
			<StatusCodesOverTimeChart
				history={history([{ "200": 90 }, { "200": 80, "404": 5, "500": 3 }])}
			/>
		);
		expect(hoverRows(1)).toEqual(["1.0s", "responses", "2xx80/s", "4xx5/s", "5xx3/s"]);
	});

	it("follows the history as it streams, with no rebuild of the plot", async () => {
		const { rerender } = render(
			<StatusCodesOverTimeChart history={history([{ "200": 10 }, { "200": 10 }])} />
		);
		// uPlot commits the new x range in a microtask.
		await act(async () => {
			rerender(
				<StatusCodesOverTimeChart
					history={history([{ "200": 10 }, { "200": 10 }, { "502": 7 }])}
				/>
			);
		});
		expect(instances.all).toHaveLength(1);
		expect(hoverRows(2)).toEqual(["2.0s", "responses", "5xx7/s"]);
	});
});
