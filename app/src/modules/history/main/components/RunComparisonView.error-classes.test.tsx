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
 * The compare view's Error classes table (#3828): the failed MCP replies of
 * both runs by class, beside the status codes. It is drawn only when both runs
 * recorded their classes, because a baseline stored before the engine counted
 * them is not a baseline with zero failures, and a column of zeros would read
 * as a regression the run never had.
 *
 * Mutation-check: have `compareReports` return `errorClasses: {}` and the
 * counts case fails; drop the `classes.length === 0` guard in
 * `ErrorClassTable` and both hidden cases fail on the empty table; read an
 * unrecorded side as 0 in `errorClassDeltas` and the unrecorded case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunComparisonView from "./RunComparisonView";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { ErrorClassCounts, Run, RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

/** `errorClasses` left out is a run stored before the engine counted them. */
function reportWith(errorClasses?: ErrorClassCounts): RunReport {
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
			...(errorClasses === undefined ? {} : { errorClasses }),
		},
		latency: { min: 1, max: 9, avg: 3, p50: 2, p90: 4, p95: 5, p99: 6 },
		statusCodes: { "200": 1000 },
		errors: { total: 0, withDetails: 0, types: {} },
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
		summary: { url: "https://api.example.test/mcp", method: "POST" },
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

/** The table's body rows as `[class, compared, this, change]`. */
function classRows(table: HTMLElement): string[][] {
	return within(table)
		.getAllByRole("row")
		.slice(1)
		.map((row) =>
			within(row)
				.getAllByRole("cell")
				.map((cell) => cell.textContent ?? "")
		);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RunComparisonView error classes", () => {
	it("lists the classes either run counted, in a fixed order, with the signed change", async () => {
		// The compared run (base) is the one the engine answers for; the open run is the target.
		renderCompare(
			reportWith({ tool: 3, protocol: 9, protocolCodes: { "-32602": 9 } }),
			reportWith({ tool: 10, transport: 2 })
		);

		const table = await screen.findByRole("region", { name: "Error classes" });

		expect(classRows(table)).toEqual([
			["Transport", "2", "0", "-2"],
			["Protocol", "0", "9", "+9"],
			["Tool", "10", "3", "-7"],
		]);
	});

	it("reads a run that recorded nothing failed as 0, not as unrecorded", async () => {
		renderCompare(reportWith({ protocol: 4 }), reportWith({}));

		const table = await screen.findByRole("region", { name: "Error classes" });

		expect(classRows(table)).toEqual([["Protocol", "0", "4", "+4"]]);
	});

	it.each([
		["the compared run never recorded them", reportWith({ tool: 5 }), reportWith()],
		["the open run never recorded them", reportWith(), reportWith({ tool: 5 })],
		["neither run recorded them", reportWith(), reportWith()],
		["both runs recorded that nothing failed", reportWith({}), reportWith({})],
	])("draws no table when %s", async (_name, open, compared) => {
		renderCompare(open, compared);

		// Wait on the rest of the comparison, so the absence is read after it rendered.
		await screen.findByRole("region", { name: "Status codes" });

		expect(screen.queryByRole("region", { name: "Error classes" })).toBeNull();
	});
});
