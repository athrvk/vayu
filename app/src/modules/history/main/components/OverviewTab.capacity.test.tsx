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
 * The history Overview hands the Capacity summary the run's step length
 * (`metadata.configuration.stepDuration`, #2927), so the stop detail can say how
 * long each measurement of a level lasted.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

function makeReport(stepDuration?: string): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 30_000,
			configuration: { mode: "capacity", duration: "30s", stepDuration },
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 100,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 30,
			avgRps: 3,
		},
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		capacity: {
			sloMs: 200,
			stopReason: "slo_exceeded",
			maxHealthyConcurrency: 48,
			maxHealthyRps: 23400,
			p99AtMaxHealthyMs: 41.2,
			kneeConcurrency: 64,
			kneeP99Ms: 312,
			levels: [
				{ concurrency: 48, rps: 23400, p99Ms: 41.2 },
				{ concurrency: 64, rps: 23000, p99Ms: 312 },
			],
		},
	};
}

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

describe("OverviewTab capacity stop detail", () => {
	it("names the step length the report carries", () => {
		renderTab(makeReport("5s"));
		expect(
			screen.getByText(/two consecutive measurements of the level \(each 5s long\)/)
		).toBeInTheDocument();
	});

	it("omits the step length for a run that left the step at its default", () => {
		renderTab(makeReport());
		expect(screen.getByText(/two consecutive measurements of the level\./)).toBeInTheDocument();
		expect(screen.queryByText(/each .* long/)).toBeNull();
	});
});
