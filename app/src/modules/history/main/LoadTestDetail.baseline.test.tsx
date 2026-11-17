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
 * A collection load run is judged against its collection's pin (#3544).
 *
 * Its `requestId` is null and the only identity it has is the collection in its
 * snapshot's scenario manifest. The engine is faked as the real one answers
 * `GET /runs?baseline=true&collectionId=...`, by filtering the pins on the
 * collection asked for - so a pane that asked for nobody's pin, or for the
 * wrong one, is what these cases catch.
 *
 * Mutation check: make `runIdentity` answer from `run.requestId` alone and the
 * strip case reddens; drop `collectionId` from the baseline lookup and the
 * other-collection case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { Run, RunReport } from "@/types";
import LoadTestDetail from "./LoadTestDetail";

vi.mock("@/services/api", () => ({
	apiService: {
		getRun: vi.fn(),
		listRuns: vi.fn(),
		getRunReport: vi.fn(),
		getRunTimeSeries: vi.fn(),
		getRunMonitorSeries: vi.fn(),
	},
}));

const mocked = vi.mocked(apiService);

function report(p99: number): RunReport {
	return {
		metadata: {
			runId: "run",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
		},
		summary: {
			totalRequests: 74,
			successfulRequests: 74,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 7.4,
			avgRps: 10,
		},
		latency: { min: 1, max: 120, avg: 10, p50: 8, p90: 20, p95: 30, p99 },
		statusCodes: { "200": 74 },
		errors: { total: 0, withDetails: 0, types: {} },
	} as unknown as RunReport;
}

/** A collection's load run: no request, the collection only in its snapshot. */
function collectionRun(id: string, collectionId: string, over: Partial<Run> = {}): Run {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_010_000,
		requestId: null,
		environmentId: null,
		summary: { scenario: { collectionId } },
		configSnapshot: { scenario: { collectionId } },
		...over,
	} as Run;
}

const PINS: Run[] = [
	collectionRun("run_pin_a", "col_a", { baseline: true }),
	collectionRun("run_pin_b", "col_b", { baseline: true }),
];

function page(rows: Run[]) {
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
}

function serve(open: Run) {
	mocked.getRun.mockResolvedValue(open);
	mocked.listRuns.mockImplementation(async (params = {}) =>
		page(
			PINS.filter(
				(r) =>
					(!params.baseline || r.baseline === true) &&
					(params.collectionId === undefined ||
						r.summary?.scenario?.collectionId === params.collectionId)
			)
		)
	);
	mocked.getRunReport.mockResolvedValue(report(50));
	mocked.getRunTimeSeries.mockResolvedValue(page([]) as never);
	mocked.getRunMonitorSeries.mockResolvedValue(page([]) as never);
}

function renderDetail() {
	return render(withQueryClient(<LoadTestDetail report={report(100)} runId="run_open" />));
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LoadTestDetail's vs-baseline strip for a collection load run", () => {
	it("compares against the run pinned for the same collection", async () => {
		serve(collectionRun("run_open", "col_a"));
		renderDetail();

		expect(await screen.findByText("vs baseline")).toBeInTheDocument();
		expect(mocked.listRuns).toHaveBeenCalledWith(
			expect.objectContaining({ baseline: true, type: "load", collectionId: "col_a" })
		);
		expect(mocked.getRunReport).toHaveBeenCalledWith("run_pin_a");
	});

	it("draws no strip against another collection's pin", async () => {
		serve(collectionRun("run_open", "col_c"));
		renderDetail();

		await waitFor(() =>
			expect(mocked.listRuns).toHaveBeenCalledWith(
				expect.objectContaining({ baseline: true, type: "load", collectionId: "col_c" })
			)
		);
		// The lookup answered "no pin"; the pane has settled on a report.
		await screen.findByRole("tab", { name: /overview/i });
		expect(screen.queryByText("vs baseline")).not.toBeInTheDocument();
		expect(mocked.getRunReport).not.toHaveBeenCalledWith("run_pin_a");
		expect(mocked.getRunReport).not.toHaveBeenCalledWith("run_pin_b");
	});

	it("offers Compare for the collection run", async () => {
		serve(collectionRun("run_open", "col_a"));
		renderDetail();

		expect(await screen.findByRole("button", { name: "Compare" })).toBeInTheDocument();
	});
});
