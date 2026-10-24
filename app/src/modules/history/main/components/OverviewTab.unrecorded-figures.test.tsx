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
 * A failed load run the engine could not fully record (#2895) carries
 * `summary.summaryMissing` (every count is a 0 nobody measured) or
 * `summary.partial` (the last saved tick's counts, latency all zeros). The
 * Overview says so, and draws "not recorded" where a 0 would pass for a
 * measurement.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

type Flags = Pick<RunReport["summary"], "partial" | "summaryMissing">;

function makeReport(flags: Flags, counts: { total: number; failed: number }): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "failed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "20s", targetRps: 50 },
		},
		summary: {
			totalRequests: counts.total,
			successfulRequests: counts.total - counts.failed,
			failedRequests: counts.failed,
			errorRate: counts.total > 0 ? (counts.failed / counts.total) * 100 : 0,
			totalDurationSeconds: 3,
			avgRps: 0,
			...flags,
		},
		latency: { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
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

describe("OverviewTab unrecorded figures", () => {
	it("says the counts were not recorded and draws none of them for a run with no summary", async () => {
		renderTab(makeReport({ summaryMissing: true }, { total: 0, failed: 0 }));

		expect(await screen.findByText("Counts were not recorded")).toBeInTheDocument();
		expect(screen.getByText(/the run ended before the totals were saved/)).toBeInTheDocument();
		// P99, total requests and success rate: three tiles, no 0 and no 0.0%.
		expect(screen.getAllByText("not recorded")).toHaveLength(3);
		expect(screen.queryByText("0.0%")).toBeNull();
		// The cards under the tiles would each draw a measured-looking 0.
		expect(screen.queryByText("Error rate")).toBeNull();
		// The tile's own label is the only "Total requests" left.
		expect(screen.getAllByText("Total requests")).toHaveLength(1);
	});

	it("keeps the last saved counts and marks only the latency for a partial run", async () => {
		renderTab(makeReport({ partial: true }, { total: 1_234, failed: 234 }));

		expect(await screen.findByText("Counts are partial")).toBeInTheDocument();
		expect(screen.getByText(/these are the last figures it recorded/)).toBeInTheDocument();
		expect(screen.getByText("1,234")).toBeInTheDocument();
		expect(screen.getByText("81.0%")).toBeInTheDocument();
		// Only p99 is unrecorded.
		expect(screen.getAllByText("not recorded")).toHaveLength(1);
		expect(screen.queryByText("Error rate")).toBeNull();
	});

	it("shows neither notice nor placeholder for a run that recorded its summary", async () => {
		const report = makeReport({}, { total: 1_234, failed: 234 });
		report.latency.p99 = 87;
		renderTab(report);

		// The glance under the tiles is drawn too; the tiles alone are not unique text.
		expect(await screen.findByText("Error rate")).toBeInTheDocument();
		expect(screen.queryByText("Counts were not recorded")).toBeNull();
		expect(screen.queryByText("Counts are partial")).toBeNull();
		expect(screen.queryByText("not recorded")).toBeNull();
		expect(screen.getAllByText("87ms").length).toBeGreaterThan(0);
		expect(screen.getAllByText("1,234").length).toBeGreaterThan(0);
	});
});
