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
 * The live dashboard's report view is the second host of the verdict card
 * (#2047): it hands the card `report.metadata.runId`, so a budget copied here
 * names the same run the history detail's would.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport } from "@/types";

function makeReport(withRunId: boolean): RunReport {
	return {
		...(withRunId && {
			metadata: {
				runId: "run_1",
				runType: "load" as const,
				status: "completed" as const,
				startTime: 0,
				endTime: 60_000,
				configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
			},
		}),
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 60,
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

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("RequestResponseView Copy for agent", () => {
	it("names the budget by its key and the report's run", async () => {
		render(withQueryClient(<RequestResponseView report={makeReport(true)} />));

		fireEvent.click(screen.getByRole("button", { name: "Copy p99 latency budget for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu threshold "latencyP99Ms" of run (run_1)');
	});

	it("is absent when the report carries no run id", () => {
		render(withQueryClient(<RequestResponseView report={makeReport(false)} />));

		expect(screen.getByText("Pass/fail budgets")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});
});
