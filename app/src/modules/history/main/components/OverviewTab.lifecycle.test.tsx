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
 * A load run whose collection setup failed sent nothing, so its report has no
 * results; the Overview still has to say why (#3455).
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

function failedSetupReport(): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "failed",
			startTime: 0,
			endTime: 1_000,
			configuration: { mode: "constant_rps", duration: "20s", targetRps: 50 },
		},
		summary: {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 0,
		},
		latency: { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		results: [],
		lifecycle: {
			setup: [
				{
					id: "el_1",
					kind: "script.setup",
					outcome: "failed",
					message: "setup assertion failed: token missing",
					console: [{ level: "log", text: "fetching a token" }],
				},
			],
		},
	};
}

describe("OverviewTab setup that refused the run", () => {
	it("shows the setup's reason and console with no results to draw", () => {
		const report = failedSetupReport();
		render(
			withQueryClient(
				<OverviewTab
					report={report}
					runId="run_1"
					derived={reportToDerived(report)}
					anomalies={[]}
				/>
			)
		);
		expect(screen.getByText("setup assertion failed: token missing")).toBeInTheDocument();
		expect(screen.getByText("fetching a token")).toBeInTheDocument();
	});
});
