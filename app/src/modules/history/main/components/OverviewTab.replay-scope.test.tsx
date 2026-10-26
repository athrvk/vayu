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
 * The denominator the Overview gives the sampled replay card (#2824). A scenario
 * load run's replay is a sample of the responses that carried a deferred test
 * script, not of the run's 11,350 requests; a single-request run keeps its
 * request total.
 *
 * Mutation-check: pass `report.summary.totalRequests` unconditionally (and drop
 * `replayScope`) in `OverviewTab.tsx` and the scenario cases fail; drop the
 * `report.scenario ?` guard and the "no deferred script" case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport, RunScenarioStepStat } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

const STEP: RunScenarioStepStat = {
	index: 0,
	name: "List items",
	requestId: "req_a",
	method: "GET",
	executed: 2_270,
	errors: 0,
	latency: { min: 1, p50: 2, p95: 3, p99: 4, max: 5 },
	elements: [
		{ id: "el_1", kind: "script.post", passed: 0, failed: 0, skipped: 0, deferred: 2_270 },
	],
};

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 40_000,
			configuration: { mode: "constant_rps", duration: "40s", targetRps: 300 },
		},
		summary: {
			totalRequests: 11_350,
			successfulRequests: 11_350,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 40,
			avgRps: 283,
		},
		latency: { min: 1, max: 900, avg: 20, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		testValidation: { samplesTested: 23, testsPassed: 23, testsFailed: 0, successRate: 100 },
		...overrides,
	};
}

const scenario = (
	steps: RunScenarioStepStat[],
	assertions?: { passed: number; failed: number }
): NonNullable<RunReport["scenario"]> => ({
	iterations: 2_270,
	iterationsCompleted: 2_270,
	stepsExecuted: 11_350,
	passed: 11_350,
	failed: 0,
	skipped: 0,
	errored: 0,
	stepsStored: 0,
	stepsDropped: 0,
	virtualUsers: 10,
	steps,
	assertions,
});

function renderTab(report: RunReport) {
	return render(
		withQueryClient(
			<OverviewTab
				report={report}
				runId="run_1"
				derived={reportToDerived(report)}
				anomalies={[]}
			/>
		)
	);
}

describe("OverviewTab replay denominator", () => {
	it("reads the responses that carried a script for a scenario run, not the request total", () => {
		renderTab(makeReport({ scenario: scenario([STEP], { passed: 9_000, failed: 0 }) }));

		expect(
			screen.getByText(
				"Replayed 23 of the 2,270 responses that carried a test script (1 step). Assertions that ran inline are counted under Assertions."
			)
		).toBeInTheDocument();
		expect(screen.queryByText(/11,350 requests/)).toBeNull();
	});

	it("drops the Assertions pointer when the run made no inline assertion", () => {
		renderTab(makeReport({ scenario: scenario([STEP]) }));

		expect(
			screen.getByText(
				"Replayed 23 of the 2,270 responses that carried a test script (1 step)."
			)
		).toBeInTheDocument();
	});

	it("states no denominator for a scenario run in which no step deferred a script", () => {
		const bare = { ...STEP, elements: undefined };
		renderTab(makeReport({ scenario: scenario([bare]) }));

		expect(screen.getByText("Responses tested")).toBeInTheDocument();
		expect(screen.queryByText(/Tested/)).toBeNull();
		expect(screen.queryByText(/Replayed/)).toBeNull();
	});

	it("keeps a single-request run's request total", () => {
		renderTab(makeReport({ scenario: undefined }));

		expect(
			screen.getByText(
				"Tested 23 of 11,350 requests. The rest had no response or were not kept."
			)
		).toBeInTheDocument();
		expect(screen.queryByText(/Replayed/)).toBeNull();
	});
});
