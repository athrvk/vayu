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
 * A failed load run the engine could not fully record (#2895) has an all-zero
 * latency block. The Performance tab must not draw it as measurements: one
 * "not recorded" line replaces the percentile tiles and the HDR plot card, for
 * both flags, and a run that recorded its summary keeps them.
 *
 * Mutation-check: have `PerformanceTab` ignore `unrecordedFiguresOf(...).latency`
 * and the flagged cases fail on the 0 ms tiles and the HDR card.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

vi.mock("@/modules/dashboard/components/charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/dashboard/components/charts/uplot")>()),
	HdrPercentileChart: () => null,
}));

const PerformanceTab = (await import("./PerformanceTab")).default;

type Flags = Pick<RunReport["summary"], "partial" | "summaryMissing">;

function makeReport(flags: Flags, latency: Partial<RunReport["latency"]>): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status: "failed" },
		summary: {
			totalRequests: 100,
			failedRequests: 0,
			requestsPerSecond: 10,
			testDuration: 10,
			errorRate: 0,
			...flags,
		},
		latency: { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, ...latency },
	} as unknown as RunReport;
}

// `runId` is left off so the uPlot time-series charts stay out of the tree.
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

describe("PerformanceTab unrecorded latency", () => {
	it.each([
		["summaryMissing", { summaryMissing: true }],
		["partial", { partial: true }],
	] as const)("says the latency was not recorded for a %s run", (_name, flags) => {
		renderTab(makeReport(flags, {}));

		expect(screen.getByText("Latency distribution")).toBeInTheDocument();
		expect(screen.getAllByText("not recorded")).toHaveLength(1);
		expect(screen.queryByText("P99")).toBeNull();
		expect(screen.queryByText("Average")).toBeNull();
		expect(screen.queryByText(/^0\s?ms$/)).toBeNull();
		expect(screen.queryByText("HDR percentile plot")).toBeNull();
	});

	it("draws the tiles and the HDR plot card for a run that recorded its summary", () => {
		renderTab(makeReport({}, { avg: 2, p50: 2, p95: 3, p99: 4 }));

		expect(screen.queryByText("not recorded")).toBeNull();
		expect(screen.getByText("P99")).toBeInTheDocument();
		expect(screen.getByText("Average")).toBeInTheDocument();
		expect(screen.getByText("HDR percentile plot")).toBeInTheDocument();
	});
});
