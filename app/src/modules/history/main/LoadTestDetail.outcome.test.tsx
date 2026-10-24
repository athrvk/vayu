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
 * A stored run opens on its verdict (#2130), the same banner the live dashboard
 * draws, from the report it was handed.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function report(overrides: Partial<RunReport> = {}): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 85,
			failedRequests: 15,
			errorRate: 15,
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
		statusCodes: { "200": 85, "500": 15 },
		errors: { total: 15, withDetails: 0, types: {} },
		...overrides,
	} as RunReport;
}

function renderReport(value: RunReport) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={value} runId="r" />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

describe("the run report's verdict banner", () => {
	it("calls budgets met over 15% errors Not judged", () => {
		renderReport(
			report({
				thresholdValidation: {
					checks: [{ metric: "latencyP95Ms", limit: 50, actual: 1, passed: true }],
					passed: 1,
					failed: 0,
					verdict: "passed",
				},
			})
		);

		expect(screen.getByText("Not judged")).toBeInTheDocument();
		expect(screen.getByText(/The budget was met, but 15.0% errors/)).toBeInTheDocument();
	});

	it("does not call a run with every assertion failed and 0.0% errors a pass (#2820)", () => {
		renderReport(
			report({
				summary: {
					totalRequests: 4580,
					successfulRequests: 4580,
					failedRequests: 0,
					errorRate: 0,
					totalDurationSeconds: 1,
					avgRps: 4580,
				},
				statusCodes: { "200": 4580 },
				errors: { total: 0, withDetails: 0, types: {} },
				scenario: {
					iterations: 100,
					iterationsCompleted: 100,
					stepsExecuted: 4580,
					passed: 4580,
					failed: 0,
					skipped: 0,
					errored: 0,
					stepsStored: 0,
					stepsDropped: 0,
					virtualUsers: 10,
					assertions: { passed: 0, failed: 4580 },
				},
			})
		);

		expect(screen.getByText("Not judged")).toBeInTheDocument();
		expect(
			screen.getByText(/No budgets set\. 0\.0% errors, 4,580 assertions failed/)
		).toBeInTheDocument();
	});

	it("says Failed for a failed status", () => {
		renderReport(report({ metadata: { ...report().metadata!, status: "failed" } }));

		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("draws no banner for a report that does not say how the run ended", () => {
		renderReport(report({ metadata: undefined }));

		expect(screen.queryByText("Not judged")).toBeNull();
		expect(screen.queryByText("Passed")).toBeNull();
	});
});
