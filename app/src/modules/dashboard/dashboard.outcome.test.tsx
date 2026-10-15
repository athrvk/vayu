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
 * The verdict a finished run opens on (#2130).
 *
 * `completed` says the run ended, not that it held its budgets, so the
 * dashboard states the verdict above the tabs and hands the header the same
 * one for its pill. A run still streaming, or a report that has not arrived,
 * has no verdict and gets no banner - never "Not judged" over a missing report.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { RunReport } from "@/types";
import LoadTestDashboard from "./index";

vi.mock("./components", () => ({
	DashboardHeader: ({ outcome }: { outcome?: string }) => (
		<div data-testid="header" data-outcome={outcome ?? ""} />
	),
	MetricsView: () => null,
	RequestResponseView: () => null,
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

function report(overrides: Partial<RunReport> = {}): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1,
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 100,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 100,
		},
		latency: {
			min: 1,
			max: 1,
			avg: 1,
			median: 1,
			p50: 1,
			p75: 1,
			p90: 1,
			p95: 1,
			p99: 1,
			p999: 1,
		},
		...overrides,
	} as RunReport;
}

const MISSED: RunReport["thresholdValidation"] = {
	checks: [
		{ metric: "latencyP95Ms", limit: 50, actual: 80, passed: false },
		{ metric: "minThroughputRps", limit: 10, actual: 100, passed: true },
	],
	passed: 1,
	failed: 1,
	verdict: "failed",
};

function seed(
	mode: "running" | "completed" | "failed" | "stopped",
	finalReport: RunReport | null,
	isStreaming = false
) {
	useDashboardStore.setState({ currentRunId: "run_1", mode, isStreaming, finalReport });
}

afterEach(() => {
	useDashboardStore.setState({ currentRunId: null, finalReport: null });
});

describe("the dashboard's verdict banner", () => {
	it("names the missed budgets and tells the header", () => {
		seed("completed", report({ thresholdValidation: MISSED }));
		render(<LoadTestDashboard />);

		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText(/1 of 2 budgets missed: p95/)).toBeInTheDocument();
		expect(screen.getByTestId("header").dataset.outcome).toBe("failed");
	});

	it("says Not judged for a run with no budgets, never Passed", () => {
		seed("completed", report());
		render(<LoadTestDashboard />);

		expect(screen.getByText("Not judged")).toBeInTheDocument();
		expect(screen.getByText(/No budgets set. 0.0% errors/)).toBeInTheDocument();
		expect(screen.queryByText("Passed")).toBeNull();
		expect(screen.getByTestId("header").dataset.outcome).toBe("not-judged");
	});

	it("says Not judged, stopped before it finished, for a run the user stopped (#2136)", () => {
		seed(
			"stopped",
			report({
				metadata: {
					runId: "run_1",
					runType: "load",
					status: "stopped",
					startTime: 0,
					endTime: 1,
				},
				thresholdValidation: MISSED,
			})
		);
		render(<LoadTestDashboard />);

		expect(screen.getByText("Not judged")).toBeInTheDocument();
		expect(screen.getByText(/Stopped before it finished/)).toBeInTheDocument();
		expect(screen.queryByText("Failed")).toBeNull();
		expect(screen.getByTestId("header").dataset.outcome).toBe("not-judged");
	});

	it("draws no banner while the run is streaming", () => {
		seed("running", report({ metadata: undefined }), true);
		render(<LoadTestDashboard />);

		expect(screen.queryByText("Not judged")).toBeNull();
		expect(screen.queryByText("Failed")).toBeNull();
		expect(screen.getByTestId("header").dataset.outcome).toBe("");
	});

	it("draws no banner for a finished run whose report has not arrived", () => {
		seed("completed", null);
		render(<LoadTestDashboard />);

		expect(screen.queryByText("Not judged")).toBeNull();
		expect(screen.getByTestId("header").dataset.outcome).toBe("");
	});
});
