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
 * The tab is where a sample learns which run it belongs to (#2047): the card
 * is handed `report.metadata.runId` and the sample's own result row id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import SamplesTab from "./SamplesTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: vi.fn() },
}));

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
		results: [
			{
				id: 7,
				timestamp: 1_700_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 2,
			},
		],
	};
}

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

function renderTab(report: RunReport) {
	return render(
		withQueryClient(<SamplesTab report={report} derived={reportToDerived(report)} />)
	);
}

describe("SamplesTab Copy for agent", () => {
	it("names the sample by its result id and the report's run", async () => {
		renderTab(makeReport());

		fireEvent.click(screen.getByRole("button", { name: "Copy sample 1 for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith("Vayu run sample (7) of run (run_1)");
	});

	it("is absent when the report carries no run id", () => {
		// A report fetched without its metadata block: nothing names the run.
		renderTab({ ...makeReport(), metadata: undefined });

		expect(screen.getByText("#1")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /for agent$/ })).toBeNull();
	});
});
