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
 * The Overview is where a verdict learns which run it judged (#2047): the
 * shared card is handed `report.metadata.runId`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

function makeReport(): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 60_000,
			configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
		},
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

function renderTab(report: RunReport) {
	return render(
		withQueryClient(
			<OverviewTab
				report={report}
				runId={report.metadata?.runId ?? ""}
				derived={reportToDerived(report)}
				anomalies={[]}
			/>
		)
	);
}

describe("OverviewTab Copy for agent", () => {
	it("names the budget by its key and the report's run", async () => {
		renderTab(makeReport());

		fireEvent.click(screen.getByRole("button", { name: "Copy p99 latency budget for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu threshold "latencyP99Ms" of run (run_1)');
	});

	it("is absent when the report carries no run id", () => {
		renderTab({ ...makeReport(), metadata: undefined });

		expect(screen.getByText("Pass/fail budgets")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});
});
