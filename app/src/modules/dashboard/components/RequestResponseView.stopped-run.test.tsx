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
 * The live dashboard report view is a host of the budgets card (#2194): it hands the card
 * `stoppedRunOf(report)`, so a stopped run's verdict says how much of the plan
 * it covers and a completed run's says nothing extra.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport } from "@/types";

function makeReport(status: "completed" | "stopped"): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status,
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "20s", targetRps: 50 },
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

describe("RequestResponseView stopped run note", () => {
	it("qualifies the verdict of a stopped run", () => {
		renderView(makeReport("stopped"));
		expect(
			screen.getByText(
				"Run stopped after 3s of a planned 20s. Judged on what was measured up to that point."
			)
		).toBeInTheDocument();
		expect(screen.getByText("1 of 1 budgets met.")).toBeInTheDocument();
	});

	it("adds nothing to a completed run", () => {
		renderView(makeReport("completed"));
		expect(screen.getByText("1 of 1 budgets met.")).toBeInTheDocument();
		expect(screen.queryByText(/Run stopped/)).toBeNull();
	});
});
