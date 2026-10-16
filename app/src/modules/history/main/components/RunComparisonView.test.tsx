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
 * The full compare view (#2164): the open run against any other finished load
 * run of the same request, defaulting to the pinned baseline.
 *
 * The engine does the narrowing to one request and one run type, so the mock
 * answers `listRuns` by filtering a shared pool on the same params - which is
 * what lets "only runs of the same request" be a claim about what the view
 * asks for, not about what the fixture happened to contain.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunComparisonView from "./RunComparisonView";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import { ApiError } from "@/services";
import { formatInstant } from "@/lib/time-value";
import type { Run, RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

interface ReportShape {
	p50: number;
	p90: number;
	p95: number;
	p99: number;
	avg: number;
	max: number;
	avgRps: number;
	throughput: number;
	errorRate: number;
	totalRequests: number;
	statusCodes: Record<string, number>;
	status?: string;
	testDuration?: number;
}

function report(over: ReportShape): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: over.status ?? "completed",
			startTime: 0,
			endTime: 1000,
		},
		summary: {
			totalRequests: over.totalRequests,
			successfulRequests: over.totalRequests,
			failedRequests: 0,
			errorRate: over.errorRate,
			totalDurationSeconds: 10,
			avgRps: over.avgRps,
			throughput: over.throughput,
			...(over.testDuration === undefined ? {} : { testDuration: over.testDuration }),
		},
		latency: {
			min: 1,
			max: over.max,
			avg: over.avg,
			p50: over.p50,
			p90: over.p90,
			p95: over.p95,
			p99: over.p99,
		},
		statusCodes: over.statusCodes,
		errors: { total: 0, withDetails: 0, types: {} },
	} as RunReport;
}

/** The open run. */
const OPEN = report({
	p50: 10,
	p90: 20,
	p95: 30,
	p99: 40,
	avg: 15,
	max: 90,
	avgRps: 200,
	throughput: 190,
	errorRate: 2,
	totalRequests: 2000,
	statusCodes: { "200": 1960, "404": 40 },
});

/** The pinned baseline: every figure different from OPEN and from OLD. */
const PINNED = report({
	p50: 8,
	p90: 16,
	p95: 24,
	p99: 32,
	avg: 12,
	max: 70,
	avgRps: 150,
	throughput: 140,
	errorRate: 1,
	totalRequests: 1500,
	statusCodes: { "200": 1485, "500": 15 },
});

const OLD = report({
	p50: 5,
	p90: 6,
	p95: 7,
	p99: 9,
	avg: 6,
	max: 11,
	avgRps: 300,
	throughput: 295,
	errorRate: 0,
	totalRequests: 3000,
	statusCodes: { "200": 3000 },
});

function run(id: string, over: Partial<Run> = {}): Run {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...over,
	} as Run;
}

const DAY = 86_400_000;
const T = 1_750_000_000_000;

const POOL: Run[] = [
	run("run_open", { startTime: T }),
	run("run_pinned", { startTime: T - DAY, baseline: true }),
	run("run_old", { startTime: T - 2 * DAY, status: "stopped" }),
	run("run_live", { startTime: T + DAY, status: "running" }),
	run("run_failed", { startTime: T - 3 * DAY, status: "failed" }),
	run("run_design", { startTime: T - 4 * DAY, type: "design" }),
	run("run_elsewhere", { startTime: T - 5 * DAY, requestId: "req_2" }),
];

let reports: Record<string, RunReport> = {};

function page(rows: Run[]) {
	return {
		data: rows,
		pagination: {
			total: rows.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: rows.length,
		},
	};
}

/** Answers the way the engine does: by the filters the view passed. */
function serve(pool: Run[]) {
	mocked.listRuns.mockImplementation(async (params = {}) => {
		const rows = pool.filter(
			(r) =>
				(params.requestId === undefined || r.requestId === params.requestId) &&
				(params.type === undefined || r.type === params.type) &&
				(!params.baseline || r.baseline === true)
		);
		return page(rows.slice(0, params.limit));
	});
	mocked.getRun.mockImplementation(async (id: string) => pool.find((r) => r.id === id)!);
	mocked.getRunReport.mockImplementation(async (id: string) => reports[id]);
}

function renderView(onClose = vi.fn()) {
	render(
		withQueryClient(
			<RunComparisonView report={OPEN} runId="run_open" requestId="req_1" onClose={onClose} />
		)
	);
	return onClose;
}

const picker = () => screen.getByRole("combobox", { name: "Compared run" });

/** A row's cells as text, so a figure is asserted against the row it belongs to. */
function rowCells(name: RegExp): string[] {
	const row = screen.getByRole("row", { name });
	return within(row)
		.getAllByRole("cell")
		.map((cell) => cell.textContent ?? "");
}

beforeEach(() => {
	vi.clearAllMocks();
	reports = { run_pinned: PINNED, run_old: OLD };
	serve(POOL);
});

describe("RunComparisonView", () => {
	it("renders every percentile, both throughput measures and the reliability rows", async () => {
		renderView();

		await screen.findByRole("row", { name: /P50 latency/ });

		// [compared run, this run, change]: the compared run is the base.
		expect(rowCells(/P50 latency/).slice(1)).toEqual([
			"8ms",
			"10ms",
			expect.stringContaining("+25.0%"),
		]);
		expect(rowCells(/P90 latency/).slice(1, 3)).toEqual(["16ms", "20ms"]);
		expect(rowCells(/P95 latency/).slice(1, 3)).toEqual(["24ms", "30ms"]);
		expect(rowCells(/P99 latency/).slice(1, 3)).toEqual(["32ms", "40ms"]);
		expect(rowCells(/Average latency/).slice(1, 3)).toEqual(["12ms", "15ms"]);
		expect(rowCells(/Max latency/).slice(1, 3)).toEqual(["70ms", "90ms"]);
		expect(rowCells(/^Throughput/).slice(1, 3)).toEqual(["150 rps", "200 rps"]);
		expect(rowCells(/Response rate/).slice(1, 3)).toEqual(["140 rps", "190 rps"]);
		expect(rowCells(/Error rate/).slice(1, 3)).toEqual(["1.00%", "2.00%"]);
		expect(rowCells(/Total requests/).slice(1, 3)).toEqual(["1,500", "2,000"]);
	});

	it("merges the status codes of both runs into one table", async () => {
		renderView();

		const table = await screen.findByRole("region", { name: "Status codes" });
		const rows = within(table)
			.getAllByRole("row")
			.slice(1)
			.map((row) =>
				within(row)
					.getAllByRole("cell")
					.map((cell) => cell.textContent)
			);
		// A code only one run saw is a zero on the other side, not a missing row.
		expect(rows).toEqual([
			["200", "1,485", "1,960", "+475"],
			["404", "0", "40", "+40"],
			["500", "15", "0", "-15"],
		]);
	});

	it("colours the change by direction, not by sign", async () => {
		renderView();

		await screen.findByRole("row", { name: /P50 latency/ });
		// Latency up is a regression; throughput up is an improvement.
		expect(
			screen
				.getByRole("row", { name: /P99 latency/ })
				.querySelector(".text-status-error-text")
		).not.toBeNull();
		expect(
			screen
				.getByRole("row", { name: /^Throughput/ })
				.querySelector(".text-status-success-text")
		).not.toBeNull();
	});

	it("offers only the finished load runs of this request, never the open run", async () => {
		renderView();
		await screen.findByRole("row", { name: /P50 latency/ });

		expect(mocked.listRuns).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req_1", type: "load" })
		);

		fireEvent.click(picker());
		const options = screen.getAllByRole("option").map((o) => o.textContent);
		// The pinned run and the stopped one: not the open run, the running one,
		// the failed one, a design run or another request's run.
		expect(options).toEqual([
			`${formatInstant(T - DAY)} - Completed - Baseline`,
			`${formatInstant(T - 2 * DAY)} - Stopped`,
		]);
	});

	it("defaults to the pinned baseline when one exists", async () => {
		renderView();
		await screen.findByRole("row", { name: /P50 latency/ });

		expect(mocked.getRunReport).toHaveBeenCalledWith("run_pinned");
		expect(mocked.getRunReport).not.toHaveBeenCalledWith("run_old");
		expect(picker()).toHaveTextContent("Baseline");
	});

	it("compares against the run the picker selects instead", async () => {
		renderView();
		await screen.findByRole("row", { name: /P50 latency/ });

		fireEvent.click(picker());
		fireEvent.click(screen.getByRole("option", { name: /Stopped/ }));

		await waitFor(() => expect(mocked.getRunReport).toHaveBeenCalledWith("run_old"));
		await waitFor(() => expect(rowCells(/P99 latency/).slice(1, 3)).toEqual(["9ms", "40ms"]));
		expect(picker()).toHaveTextContent("Stopped");
	});

	it("falls back to the newest other run when nothing is pinned", async () => {
		serve(POOL.map((r) => ({ ...r, baseline: false })));
		renderView();

		await screen.findByRole("row", { name: /P50 latency/ });
		// run_pinned is the newest of the two finished runs.
		expect(mocked.getRunReport).toHaveBeenCalledWith("run_pinned");
		expect(picker()).not.toHaveTextContent("Baseline");
	});

	it("keeps a pinned baseline that is older than the page of runs", async () => {
		const pinned = POOL.find((r) => r.id === "run_pinned")!;
		serve(POOL);
		mocked.listRuns.mockImplementation(async (params = {}) =>
			// The pin query asks for baselines; the page of runs does not contain it.
			page(params.baseline ? [pinned] : [POOL[0], POOL[2]])
		);
		renderView();

		await screen.findByRole("row", { name: /P50 latency/ });
		expect(mocked.getRunReport).toHaveBeenCalledWith("run_pinned");
	});

	it("lists what makes the two runs different experiments above the table", async () => {
		reports.run_pinned = report({ ...basePinned(), status: "stopped" });
		renderView();

		const list = await screen.findByRole("list", { name: "Comparability warnings" });
		// The compared run's value, then this run's.
		expect(
			within(list).getByText("Run status differs. Stopped vs Completed.")
		).toBeInTheDocument();
	});

	it("says there is nothing to compare when the request has no other finished run", async () => {
		serve([POOL[0], POOL[3]]);
		renderView();

		expect(await screen.findByText("No other runs to compare")).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		expect(mocked.getRunReport).not.toHaveBeenCalled();
	});

	it("tells a deleted compared run from a failure and keeps the picker", async () => {
		mocked.getRun.mockRejectedValue(new ApiError(404, "NOT_FOUND", "HTTP 404", {}));
		renderView();

		expect(await screen.findByText("This run no longer exists")).toBeInTheDocument();
		expect(picker()).toBeInTheDocument();
		expect(screen.queryByRole("row", { name: /P50 latency/ })).not.toBeInTheDocument();
	});

	it("offers the way back to the report", async () => {
		const onClose = renderView();
		await screen.findByRole("row", { name: /P50 latency/ });

		fireEvent.click(screen.getByRole("button", { name: "Back to report" }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

/** PINNED's figures, so a case can change one field without restating the rest. */
function basePinned(): ReportShape {
	return {
		p50: 8,
		p90: 16,
		p95: 24,
		p99: 32,
		avg: 12,
		max: 70,
		avgRps: 150,
		throughput: 140,
		errorRate: 1,
		totalRequests: 1500,
		statusCodes: { "200": 1485, "500": 15 },
	};
}
