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
 * The live dashboard report view is a host of the budgets card (#2195): it hands the card
 * `metadata.configuration.carriedBudgets`, so a carried budget is tagged on
 * screen and a run that sent none looks as it always did.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport } from "@/types";

function makeReport(carriedBudgets?: string[]): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "20s", targetRps: 50, carriedBudgets },
		},
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 1,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		thresholdValidation: {
			checks: [{ metric: "latencyP99Ms", limit: 50, actual: 5, passed: true }],
			passed: 1,
			failed: 0,
			verdict: "passed",
		},
	};
}

function renderView(report: RunReport) {
	return render(withQueryClient(<RequestResponseView report={report} />));
}

describe("RequestResponseView carried budgets", () => {
	it("tags the budget the report names as carried over", () => {
		renderView(makeReport(["latencyP99Ms"]));
		expect(screen.getByText("carried over")).toBeInTheDocument();
		expect(screen.getByText("1 of 1 budgets met (1 carried over).")).toBeInTheDocument();
	});

	it("tags nothing for a run that sent no carried list", () => {
		renderView(makeReport());
		expect(screen.queryByText("carried over")).toBeNull();
		expect(screen.getByText("1 of 1 budgets met.")).toBeInTheDocument();
	});
});
