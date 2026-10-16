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
 * The Samples tab opens oldest first and narrows by status class (#2212). The
 * report lists the rows out of time order on purpose - the engine hands back a
 * failures-first selection - so an arrival-order render fails the order test.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SamplesTab from "./SamplesTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";
import type { SampleFilter } from "../sample-filter";

vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

type Row = NonNullable<RunReport["results"]>[number];

// The latency is the timestamp offset in hundredths, so a row's identity reads off
// the screen as "10.0ms" without depending on its number.
function row(ts: number, statusCode: number, extra: Partial<Row> = {}): Row {
	return { timestamp: 1_700_000_000_000 + ts, statusCode, latencyMs: ts / 100, ...extra };
}

// In time order: 1000 -> 200, 2000 -> 404, 3000 -> 503, 4000 -> 200 (slow),
// 5000 -> no response, 6000 -> 500.
const ARRIVAL_ORDER: Row[] = [
	row(3000, 503),
	row(1000, 200),
	row(2000, 404),
	row(5000, 0, { error: "Couldn't connect" }),
	row(4000, 200, { trace: { isSlow: true, thresholdMs: 30 } }),
	row(6000, 500),
];

function makeReport(results: Row[] = ARRIVAL_ORDER): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 60_000,
			configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
		},
		summary: {
			totalRequests: results.length,
			successfulRequests: 2,
			failedRequests: 4,
			errorRate: 0,
			totalDurationSeconds: 60,
			avgRps: 1,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		results,
	};
}

function renderTab(
	report: RunReport = makeReport(),
	props: { filter?: SampleFilter; onFilterChange?: (f: SampleFilter) => void } = {}
) {
	return render(
		withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} {...props} />)
	);
}

const rowNumbers = () => screen.queryAllByText(/^#\d+$/).map((el) => el.textContent);
const rowLatencies = () => screen.queryAllByText(/^\d+\.\dms$/).map((el) => el.textContent);
const chip = (name: string, count: number) =>
	screen.getByRole("radio", { name: new RegExp(`^${name}\\s*${count}$`) });

describe("SamplesTab ordering", () => {
	it("opens oldest first, numbered in that order", () => {
		renderTab();

		expect(rowLatencies()).toEqual([
			"10.0ms",
			"20.0ms",
			"30.0ms",
			"40.0ms",
			"50.0ms",
			"60.0ms",
		]);
		expect(rowNumbers()).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
	});

	it("keeps report order between rows that share a timestamp", () => {
		renderTab(
			makeReport([
				row(1000, 500, { latencyMs: 1.1 }),
				row(1000, 200, { latencyMs: 2.2 }),
				row(1000, 404, { latencyMs: 3.3 }),
			])
		);

		expect(rowLatencies()).toEqual(["1.1ms", "2.2ms", "3.3ms"]);
	});
});

describe("SamplesTab status-class chips", () => {
	it("shows each chip with the count of the loaded rows it would show", () => {
		renderTab();

		expect(chip("All", 6)).toBeInTheDocument();
		expect(chip("Errors", 4)).toBeInTheDocument();
		expect(chip("4xx", 1)).toBeInTheDocument();
		expect(chip("5xx", 2)).toBeInTheDocument();
		expect(chip("No response", 1)).toBeInTheDocument();
		expect(chip("Slow", 1)).toBeInTheDocument();
	});

	it("starts on All", () => {
		renderTab();

		expect(chip("All", 6)).toHaveAttribute("aria-checked", "true");
	});

	it.each([
		["Errors", 4, ["20.0ms", "30.0ms", "50.0ms", "60.0ms"], ["#2", "#3", "#5", "#6"]],
		["4xx", 1, ["20.0ms"], ["#2"]],
		["5xx", 2, ["30.0ms", "60.0ms"], ["#3", "#6"]],
		["No response", 1, ["50.0ms"], ["#5"]],
		["Slow", 1, ["40.0ms"], ["#4"]],
		["All", 6, ["10.0ms", "20.0ms", "30.0ms", "40.0ms", "50.0ms", "60.0ms"], null],
	])("%s narrows to its rows and keeps their numbers", (name, count, latencies, numbers) => {
		renderTab();
		// Leave All first so the All case proves a way back, not the default.
		fireEvent.click(chip("5xx", 2));

		fireEvent.click(chip(name, count));

		expect(rowLatencies()).toEqual(latencies);
		if (numbers) expect(rowNumbers()).toEqual(numbers);
	});

	it("marks a slow row's latency, which is what the Slow chip found", () => {
		renderTab();

		expect(screen.getByText("40.0ms")).toHaveClass("text-status-stopped-text");
		expect(screen.getByText("30.0ms")).not.toHaveClass("text-status-stopped-text");
	});

	it("says so when a chip has no rows, and the chips stay", () => {
		renderTab(makeReport([row(1000, 200), row(2000, 404)]));

		fireEvent.click(chip("5xx", 0));

		expect(screen.getByText("No samples match this filter")).toBeInTheDocument();
		expect(rowLatencies()).toEqual([]);
		expect(chip("All", 2)).toBeInTheDocument();
	});

	it("does not let a click on the active chip clear the filter", () => {
		renderTab();
		fireEvent.click(chip("4xx", 1));

		fireEvent.click(chip("4xx", 1));

		expect(chip("4xx", 1)).toHaveAttribute("aria-checked", "true");
		expect(rowLatencies()).toEqual(["20.0ms"]);
	});

	it("reports the visible rows in the badge and the loaded ones against the stored total", () => {
		renderTab({ ...makeReport(), resultsStored: 4_000, resultsCap: 6 });
		expect(screen.getByText("6 samples shown")).toBeInTheDocument();

		fireEvent.click(chip("5xx", 2));

		expect(screen.getByText("2 samples shown")).toBeInTheDocument();
		expect(screen.getByText(/^6 of .*4.*000 stored$/)).toBeInTheDocument();
		// Counts do not follow the filter: they describe the loaded rows.
		expect(chip("All", 6)).toBeInTheDocument();
	});
});

describe("SamplesTab expanded row", () => {
	const rowButton = (number: number) =>
		screen.getByText(`#${number}`).closest("button") as HTMLElement;

	it("stays the same sample when a chip moves it to another position", () => {
		renderTab();
		fireEvent.click(rowButton(4));
		expect(rowButton(4)).toHaveAttribute("aria-expanded", "true");

		fireEvent.click(chip("Slow", 1));

		// Sample #4 is the first row of this view; an array index would have
		// pointed at row #1 of the full list instead.
		expect(rowButton(4)).toHaveAttribute("aria-expanded", "true");
	});

	it("does not open a different sample when the chip changes", () => {
		renderTab();
		fireEvent.click(rowButton(1));

		fireEvent.click(chip("Errors", 4));

		for (const number of [2, 3, 5, 6]) {
			expect(rowButton(number)).toHaveAttribute("aria-expanded", "false");
		}
	});
});

describe("SamplesTab controlled filter", () => {
	it("shows the filter its owner passes", () => {
		renderTab(makeReport(), { filter: "5xx" });

		expect(chip("5xx", 2)).toHaveAttribute("aria-checked", "true");
		expect(rowLatencies()).toEqual(["30.0ms", "60.0ms"]);
	});

	it("reports a click and leaves the choice to the owner", () => {
		const onFilterChange = vi.fn();
		renderTab(makeReport(), { filter: "5xx", onFilterChange });

		fireEvent.click(chip("Slow", 1));

		expect(onFilterChange).toHaveBeenCalledWith("slow");
		expect(chip("5xx", 2)).toHaveAttribute("aria-checked", "true");
	});

	it("follows the owner when it changes the filter", () => {
		const report = makeReport();
		const tab = (filter: SampleFilter) =>
			withQueryClient(
				<SamplesTab report={report} derived={reportToDerived(report)} filter={filter} />
			);
		const { rerender } = render(tab("all"));

		rerender(tab("4xx"));

		expect(rowLatencies()).toEqual(["20.0ms"]);
	});
});
