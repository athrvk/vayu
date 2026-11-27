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
 * The compare view's Stream and Custom metrics tables (#3781): the figures both
 * runs carry, beside the status codes. A run that never streamed or never
 * recorded a metric has no figure, so a table is drawn only from rows both runs
 * have, never a column of "not recorded" or a delta against a 0.
 *
 * Mutation-check: have `compareReports` return `stream: []` and the stream
 * cases fail; flip `eventsPerSecond` to `lower-is-better` in `STREAM_METRICS`
 * and the verdict case fails; drop the empty-list guard in `MetricGroup` and the
 * hidden cases fail on the empty table; read an absent side as 0 in
 * `sharedDelta` and the one-sided cases fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunComparisonView from "./RunComparisonView";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { Run, RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

type Stream = NonNullable<RunReport["stream"]>;

const distribution = (p50: number, p95 = p50) => ({ p50, p95, p99: p95, max: p95, count: 5 });

/** A stream block; `eventsPerSecond` and the first-event p50 are the figures the cases move. */
function streamBlock(eventsPerSecond: number, firstEventP50: number): Stream {
	return {
		completions: 5,
		totalEvents: 100,
		capped: 0,
		eventsPerSecond,
		events: { min: 1, max: 30, p50: 20, p90: 25, p95: 28, p99: 29, count: 5 },
		timeToFirstEvent: distribution(firstEventP50, firstEventP50 + 50),
	};
}

interface Recorded {
	stream?: Stream;
	customMetrics?: RunReport["customMetrics"];
}

/** Neither `stream` nor `customMetrics` left out is a run that recorded neither. */
function reportWith({ stream, customMetrics }: Recorded = {}): RunReport {
	return {
		metadata: { runId: "r", runType: "load", status: "completed", startTime: 0, endTime: 1000 },
		summary: {
			totalRequests: 1000,
			successfulRequests: 1000,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 10,
			avgRps: 100,
			throughput: 100,
		},
		latency: { min: 1, max: 9, avg: 3, p50: 2, p90: 4, p95: 5, p99: 6 },
		statusCodes: { "200": 1000 },
		errors: { total: 0, withDetails: 0, types: {} },
		...(stream === undefined ? {} : { stream }),
		...(customMetrics === undefined ? {} : { customMetrics }),
	};
}

function run(id: string, over: Partial<Run> = {}): Run {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/chat", method: "POST" },
		...over,
	} as Run;
}

const POOL: Run[] = [run("run_open"), run("run_other", { baseline: true })];

function renderCompare(open: RunReport, compared: RunReport) {
	mocked.listRuns.mockImplementation(async (params = {}) => {
		const rows = POOL.filter((r) => !params.baseline || r.baseline === true);
		return {
			data: rows,
			pagination: {
				total: rows.length,
				limit: 50,
				offset: 0,
				hasMore: false,
				returned: rows.length,
				nextBefore: null,
			},
		};
	});
	mocked.getRun.mockImplementation(async (id: string) => POOL.find((r) => r.id === id)!);
	mocked.getRunReport.mockImplementation(async () => compared);
	render(
		withQueryClient(
			<RunComparisonView
				report={open}
				runId="run_open"
				identity={{ requestId: "req_1" }}
				onClose={vi.fn()}
			/>
		)
	);
}

/** The table's body rows as `[metric, compared run, this run, change]`. */
function rowsOf(table: HTMLElement): string[][] {
	return within(table)
		.getAllByRole("row")
		.slice(1)
		.map((row) =>
			within(row)
				.getAllByRole("cell")
				.map((cell) => cell.textContent ?? "")
		);
}

/** The row's change cell, whose tone is what carries the verdict. */
function changeCell(table: HTMLElement, label: string): HTMLElement {
	const row = within(table)
		.getAllByRole("row")
		.find((candidate) => within(candidate).queryByText(label));
	if (!row) throw new Error(`no row labelled "${label}"`);
	return within(row).getAllByRole("cell")[3];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RunComparisonView stream", () => {
	it("lists each figure both runs carry, with its unit and the signed change", async () => {
		// The compared run (base) is the one the engine answers for; the open run is the target.
		renderCompare(
			reportWith({ stream: streamBlock(12, 150) }),
			reportWith({ stream: streamBlock(10, 100) })
		);

		const table = await screen.findByRole("region", { name: "Stream" });

		expect(rowsOf(table)).toEqual([
			["Time to first event (P50)", "100ms", "150ms", "+50.0%"],
			["Time to first event (P95)", "150ms", "200ms", "+33.3%"],
			["Events per second (whole run)", "10 events/s", "12 events/s", "+20.0%"],
			["Events per stream (P50)", "20", "20", "0.0%"],
		]);
	});

	it("colours each change by its own direction", async () => {
		// Both figures rose; a longer wait is worse and a higher event rate is better.
		renderCompare(
			reportWith({ stream: streamBlock(12, 150) }),
			reportWith({ stream: streamBlock(10, 100) })
		);

		const table = await screen.findByRole("region", { name: "Stream" });

		expect(changeCell(table, "Time to first event (P50)").innerHTML).toContain(
			"text-status-error-text"
		);
		expect(changeCell(table, "Events per second (whole run)").innerHTML).toContain(
			"text-status-success-text"
		);
	});

	it.each([
		[
			"the compared run never streamed",
			reportWith({ stream: streamBlock(12, 150) }),
			reportWith(),
		],
		["the open run never streamed", reportWith(), reportWith({ stream: streamBlock(10, 100) })],
		["neither run streamed", reportWith(), reportWith()],
	])("draws no table when %s", async (_name, open, compared) => {
		renderCompare(open, compared);

		// Wait on the rest of the comparison, so the absence is read after it rendered.
		await screen.findByRole("region", { name: "Status codes" });

		expect(screen.queryByRole("region", { name: "Stream" })).toBeNull();
	});
});

describe("RunComparisonView custom metrics", () => {
	const trend = (p50: number, p95: number) => ({ type: "trend" as const, count: 4, p50, p95 });
	const counter = (value: number) => ({ type: "counter" as const, count: 4, value });

	it("lists the names both runs recorded under one type, by name, unjudged", async () => {
		renderCompare(
			reportWith({
				customMetrics: { ttfb: trend(12, 18), hits: counter(150), only_open: counter(1) },
			}),
			reportWith({
				customMetrics: { ttfb: trend(10, 20), hits: counter(100), only_other: counter(1) },
			})
		);

		const table = await screen.findByRole("region", { name: "Custom metrics" });

		expect(rowsOf(table)).toEqual([
			["hits", "100", "150", "+50.0%"],
			["ttfb (P50)", "10", "12", "+20.0%"],
			["ttfb (P95)", "20", "18", "-10.0%"],
		]);
		// No direction is recorded for a custom metric: neither a rise nor a fall is painted.
		for (const cell of within(table)
			.getAllByRole("row")
			.slice(1)
			.map((row) => within(row).getAllByRole("cell")[3])) {
			expect(cell.innerHTML).toContain("text-muted-foreground");
		}
	});

	it("draws a name as text, never as markup", async () => {
		const name = "<img src=x onerror=alert(1)>";
		renderCompare(
			reportWith({ customMetrics: { [name]: counter(2) } }),
			reportWith({ customMetrics: { [name]: counter(1) } })
		);

		const table = await screen.findByRole("region", { name: "Custom metrics" });

		expect(within(table).getByText(name)).toBeTruthy();
		expect(table.querySelector("img")).toBeNull();
	});

	it.each([
		[
			"no name is shared",
			reportWith({ customMetrics: { a: counter(1) } }),
			reportWith({ customMetrics: { b: counter(1) } }),
		],
		[
			"a name is a counter in one run and a trend in the other",
			reportWith({ customMetrics: { a: counter(1) } }),
			reportWith({ customMetrics: { a: trend(1, 2) } }),
		],
		[
			"either run recorded none",
			reportWith({ customMetrics: { a: counter(1) } }),
			reportWith(),
		],
	])("draws no table when %s", async (_name, open, compared) => {
		renderCompare(open, compared);

		await screen.findByRole("region", { name: "Status codes" });

		expect(screen.queryByRole("region", { name: "Custom metrics" })).toBeNull();
	});
});
