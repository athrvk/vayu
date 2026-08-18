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
 * A load run's test outcomes, read from History (issue #726).
 *
 * The engine writes `testValidation` into every load-run report and stores the
 * named failures on a synthetic result row - and until this issue exactly one
 * surface read either: the live dashboard's `RequestResponseView`, mounted only
 * while the run is being watched. Reopened later, a run that failed 13 of 100
 * sampled test executions was indistinguishable from one that asserted nothing,
 * precisely where someone audits results. This is the pair of wiring guards for
 * the two tabs that answer it, which is where the defect lived - not in the
 * components, which rendered fine.
 *
 * Mutation checks: drop `<TestValidationSummary>` from `OverviewTab` and the
 * first three tests fail; drop the `sampleResultsWithoutValidationRow` call from
 * `SamplesTab` and the last two do.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import OverviewTab from "./OverviewTab";
import SamplesTab from "./SamplesTab";
import { TooltipProvider } from "@/components/ui";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

// Neither tab expands a row here, so this only keeps the lazy captured-samples
// query away from a real client.
vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

/** The synthetic failure row `run_manager.cpp` appends beside the real samples. */
const VALIDATION_ROW = {
	timestamp: 1_700_000_000_002,
	statusCode: 0,
	latencyMs: 0,
	error: "Script validation failures",
	trace: {
		failures: [
			"status is 200: expected 404 to equal 200",
			"body has token: expected undefined to exist",
		],
		totalFailed: 13,
		totalPassed: 87,
	},
};

const CAPTURED_SAMPLE = {
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	statusText: "OK",
	latencyMs: 2,
};

function makeReport(partial: Partial<RunReport> = {}): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 60_000,
			configuration: { mode: "constant_rps", duration: "60s", targetRps: 1_000 },
		},
		summary: {
			totalRequests: 60_000,
			successfulRequests: 60_000,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 60,
			avgRps: 1_000,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		...partial,
	};
}

// `HeroRow` inside the Overview carries tooltips, which need the provider the
// app shell supplies.
const renderOverview = (report: RunReport) =>
	render(
		withQueryClient(
			<TooltipProvider>
				<OverviewTab report={report} derived={reportToDerived(report)} />
			</TooltipProvider>
		)
	);

const renderSamples = (report: RunReport) =>
	render(withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} />));

describe("History Overview - a load run's test outcomes", () => {
	it("shows the run's test tallies", () => {
		renderOverview(
			makeReport({
				testValidation: {
					samplesTested: 100,
					testsPassed: 87,
					testsFailed: 13,
					successRate: 87,
				},
			})
		);

		expect(screen.getByText("Test Validation")).toBeInTheDocument();
		expect(screen.getByText("Samples Tested")).toBeInTheDocument();
		expect(screen.getByText("100")).toBeInTheDocument();
		expect(screen.getByText("13")).toBeInTheDocument();
	});

	it("names the failing assertions from the run's stored failure row", () => {
		renderOverview(
			makeReport({
				testValidation: {
					samplesTested: 100,
					testsPassed: 87,
					testsFailed: 13,
					successRate: 87,
				},
				results: [CAPTURED_SAMPLE, VALIDATION_ROW],
			})
		);

		expect(screen.getByText("status is 200: expected 404 to equal 200")).toBeInTheDocument();
		// Thirteen failed, two are stored - said out loud rather than reading as
		// the whole set of problems.
		expect(screen.getByText("Showing 2 of 13.")).toBeInTheDocument();
	});

	it("says nothing about tests for a run that asserted nothing", () => {
		// Absent, never zeros: a run without scripts must read exactly as it did
		// before this block existed.
		renderOverview(makeReport({ results: [CAPTURED_SAMPLE] }));

		expect(screen.queryByText("Test Validation")).not.toBeInTheDocument();
	});
});

describe("History Samples - the synthetic failure row", () => {
	it("does not list the failure row as a sampled request", () => {
		renderSamples(makeReport({ results: [CAPTURED_SAMPLE, VALIDATION_ROW] }));

		// One captured sample, not two - the failure row has no request behind it
		// and rendered as a junk status-0 card.
		expect(screen.getByText("1 samples shown")).toBeInTheDocument();
		expect(screen.queryByText(/Script validation failures/)).not.toBeInTheDocument();
	});

	it("says a run whose only row was the failure row captured no samples", () => {
		renderSamples(makeReport({ results: [VALIDATION_ROW] }));

		expect(screen.getByText("No sampled requests")).toBeInTheDocument();
	});
});
