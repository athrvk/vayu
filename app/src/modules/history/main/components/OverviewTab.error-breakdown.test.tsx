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
 * The report's error summary names the engine's two kinds of error (issue
 * #2124) beside the total, and the total is the same number the hero card and
 * the Request/Response view print.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import RequestResponseView from "@/modules/dashboard/components/RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

const report: RunReport = {
	metadata: {
		runId: "run_1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 60_000,
		configuration: { mode: "constant_rps", duration: "60s", targetRps: 50 },
	},
	summary: {
		totalRequests: 100,
		successfulRequests: 83,
		failedRequests: 17,
		httpErrorRequests: 15,
		noResponseRequests: 2,
		errorRate: 17,
		totalDurationSeconds: 60,
		avgRps: 2,
	},
	latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
	statusCodes: { "200": 83, "500": 15, "0": 2 },
	errors: { total: 17, withDetails: 2, types: { timeout: 2 } },
};

describe("report error summary", () => {
	it("Overview prints HTTP errors and No response beside the total", () => {
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

		const summary = screen.getByText("Error summary").closest<HTMLElement>(".enter-fade")!;
		expect(within(summary).getByText("HTTP errors").nextSibling?.textContent).toBe("15");
		expect(within(summary).getByText("No response").nextSibling?.textContent).toBe("2");
		expect(summary.textContent).toContain("17 (17.00%)");
	});

	it("Request/Response view prints the same split", () => {
		render(withQueryClient(<RequestResponseView report={report} />));

		expect(screen.getByText("Total errors:").nextSibling?.textContent).toBe("17");
		expect(screen.getByText("HTTP errors:").nextSibling?.textContent).toBe("15");
		expect(screen.getByText("No response:").nextSibling?.textContent).toBe("2");
	});
});
