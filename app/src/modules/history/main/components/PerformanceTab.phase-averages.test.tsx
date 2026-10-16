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
 * The run-level average of each network phase, on the Performance tab of a
 * finished run. It reads the spelled-out `longLabel` ("First byte"), where the
 * dense per-sample tiles read "TTFB".
 *
 * The card is gated on the averages, not on `timingBreakdown`: a run that
 * stored percentiles but no traces carries the object and no average, and the
 * card would print five dashes for it.
 *
 * Mutation-check: drop `<PhaseAveragesCard>` from `PerformanceTab.tsx` and the
 * first case fails; gate it on `timingBreakdown` alone and the percentiles-only
 * case fails.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import PerformanceTab from "./PerformanceTab";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

function makeReport(timingBreakdown?: RunReport["timingBreakdown"]): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status: "completed" },
		summary: {
			totalRequests: 100,
			failedRequests: 0,
			requestsPerSecond: 10,
			testDuration: 10,
			errorRate: 0,
		},
		latency: { min: 1, max: 9, avg: 4, p50: 4, p90: 7, p95: 8, p99: 9 },
		timingBreakdown,
	} as unknown as RunReport;
}

// `runId` is left off so the uPlot charts stay out of the tree.
function renderTab(report: RunReport) {
	return render(
		<PerformanceTab
			report={report}
			derived={{ mode: "constant_concurrency", targetRps: 0 } as unknown as DashboardDerived}
			timeSeries={[]}
			monitorSamples={[]}
		/>
	);
}

/** The label and value of one phase's cell, as the card prints them. */
const cell = (label: string) => screen.getByText(label).closest("div")?.textContent;

describe("PerformanceTab phase averages card", () => {
	it("prints each phase's average under its spelled-out label", () => {
		renderTab(
			makeReport({
				avgDnsMs: 1.5,
				avgConnectMs: 2,
				avgTlsMs: 3,
				avgFirstByteMs: 40,
				avgDownloadMs: 5,
			})
		);

		expect(screen.getByText("Timing breakdown")).toBeInTheDocument();
		expect(cell("First byte")).toMatch(/First byte\s*40\.0ms$/);
		expect(cell("DNS")).toMatch(/1\.50ms$/);
	});

	it("shows a dash for a phase the run did not report", () => {
		renderTab(makeReport({ avgFirstByteMs: 40 }));

		expect(screen.getAllByText("-")).toHaveLength(4);
	});

	it("is absent when the report carries percentiles but no averages", () => {
		renderTab(
			makeReport({
				phases: { dns: { p50: 1, p95: 2, p99: 3, max: 4, count: 10 } },
			})
		);

		expect(screen.queryByText("Timing breakdown")).toBeNull();
	});

	it("is absent from a report without a timing breakdown", () => {
		renderTab(makeReport());

		expect(screen.queryByText("Timing breakdown")).toBeNull();
	});
});
