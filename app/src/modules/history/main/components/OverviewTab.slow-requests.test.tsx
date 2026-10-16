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
 * The count behind the Samples tab's "Slow" chip, on the Overview of a finished
 * run: how many requests crossed the threshold, what it was, and their share.
 * Absent when none did, so a healthy run does not open with a card of zeros.
 *
 * Mutation-check: drop `<SlowRequestsCard>` from `OverviewTab.tsx` and the first
 * case fails; remove the `count <= 0` guard in `SlowRequestsCard.tsx` and the
 * zero-count case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

function makeReport(slowRequests?: RunReport["slowRequests"]): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 50 },
		},
		summary: {
			totalRequests: 200,
			successfulRequests: 200,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 66,
		},
		latency: { min: 1, max: 900, avg: 20, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		slowRequests,
	};
}

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

describe("OverviewTab slow requests card", () => {
	it("states the count, the threshold and the share of requests", () => {
		renderTab(makeReport({ count: 12, thresholdMs: 500, percentage: 6.04 }));

		// The card title and the count's own label.
		expect(screen.getAllByText("Slow requests")).toHaveLength(2);
		expect(screen.getByText("12")).toBeInTheDocument();
		expect(screen.getByText("500ms")).toBeInTheDocument();
		expect(screen.getByText("6.0%")).toBeInTheDocument();
	});

	it("is absent when no request crossed the threshold", () => {
		renderTab(makeReport({ count: 0, thresholdMs: 500, percentage: 0 }));

		expect(screen.queryByText("Slow requests")).toBeNull();
	});

	it("is absent from a report without the section", () => {
		renderTab(makeReport());

		expect(screen.queryByText("Slow requests")).toBeNull();
	});
});
