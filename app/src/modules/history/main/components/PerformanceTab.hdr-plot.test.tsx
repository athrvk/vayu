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
 * The HDR percentile plot and its min / mean / p50 / p95 / p99 / max footer on
 * the Performance tab of a finished run - what the dashboard's report showed
 * and History's did not (#2220). A finished run always has a report, so the
 * card is unconditional; a figure the report lacks prints a dash, never a 0.
 *
 * The plot itself is a uPlot canvas, stubbed to a marker that carries the
 * report it was handed.
 *
 * Mutation-check: drop the card from `PerformanceTab.tsx` and every case
 * fails; feed the footer `report.latency.p50` for the max and the footer case
 * fails; drop `sloMs` from the plot in `PerformanceTab` and the SLO case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useClientSettingsStore } from "@/stores";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

vi.mock("@/modules/dashboard/components/charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/dashboard/components/charts/uplot")>()),
	HdrPercentileChart: ({ report, sloMs }: { report: RunReport; sloMs?: number }) => (
		<div data-testid="hdr-plot" data-slo-ms={sloMs}>
			{report.metadata?.runId}
		</div>
	),
}));

const PerformanceTab = (await import("./PerformanceTab")).default;

function makeReport(latency: Partial<RunReport["latency"]>): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status: "completed" },
		summary: {
			totalRequests: 100,
			failedRequests: 0,
			requestsPerSecond: 10,
			testDuration: 10,
			errorRate: 0,
		},
		latency,
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

/** The footer's figure for one key, as the card prints it. */
const stat = (key: string) => screen.getByText(key, { exact: true }).parentElement?.textContent;

describe("PerformanceTab HDR percentile plot", () => {
	it("draws the plot from the report under its heading", () => {
		renderTab(makeReport({ min: 1, max: 90, avg: 10, p50: 8, p90: 30, p95: 40, p99: 70 }));

		expect(screen.getByText(/^HDR percentile plot/)).toBeInTheDocument();
		expect(screen.getByTestId("hdr-plot")).toHaveTextContent("run_1");
		expect(screen.getByText("from HdrHistogram")).toBeInTheDocument();
	});

	it("hands the plot the user's SLO so its markers judge against it (#2263)", () => {
		const before = useClientSettingsStore.getState().sloThresholdMs;
		useClientSettingsStore.setState({ sloThresholdMs: 37 });
		try {
			renderTab(makeReport({ min: 1, max: 90, avg: 10, p50: 8, p90: 30, p95: 40, p99: 70 }));

			expect(screen.getByTestId("hdr-plot")).toHaveAttribute("data-slo-ms", "37");
		} finally {
			useClientSettingsStore.setState({ sloThresholdMs: before });
		}
	});

	it("prints min, mean, p50, p95, p99 and max beneath it", () => {
		renderTab(makeReport({ min: 1, max: 90, avg: 10, p50: 8, p90: 30, p95: 40, p99: 70 }));

		expect(stat("min")).toBe("min 1ms");
		expect(stat("mean")).toBe("mean 10ms");
		expect(stat("p50")).toBe("p50 8ms");
		expect(stat("p95")).toBe("p95 40ms");
		expect(stat("p99")).toBe("p99 70ms");
		expect(stat("max")).toBe("max 90ms");
	});

	it("prints a dash, with no unit, for an end the report did not record", () => {
		renderTab(makeReport({ avg: 10, p50: 8, p90: 30, p95: 40, p99: 70 }));

		expect(stat("min")).toBe("min -");
		expect(stat("max")).toBe("max -");
	});
});
