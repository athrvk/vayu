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
 * The latency tiles judge against the run's own SLO, not against their own name
 * (#2245). P95 / P99 / P999 used to be warning and danger unconditionally, so a
 * run whose p99 was 3 ms drew a red tile. A run that declared no SLO has
 * nothing to be judged by, and the client's Settings SLO is not one (#2939).
 *
 * The SLO arrives as `derived.runSloMs` in every case rather than as a default,
 * so a tile comparing against a constant of its own fails here.
 *
 * Mutation-check: restore `variant="danger"` on the P99 tile (or drop the
 * `value > sloMs` comparison in `LatencyMetric`) and the under-SLO cases fail;
 * hard-code the threshold in `PerformanceTab` and the "reads the run's SLO"
 * case fails; fall back to the Settings SLO there and the "no SLO" case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useClientSettingsStore } from "@/stores";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

vi.mock("@/modules/dashboard/components/charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/dashboard/components/charts/uplot")>()),
	HdrPercentileChart: () => null,
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
		latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 2, ...latency },
	} as unknown as RunReport;
}

// `runId` is left off so the uPlot time-series charts stay out of the tree.
function renderTab(latency: Partial<RunReport["latency"]>, runSloMs: number | null = 200) {
	return render(
		<PerformanceTab
			report={makeReport(latency)}
			derived={
				{
					mode: "constant_concurrency",
					targetRps: 0,
					runSloMs: runSloMs ?? undefined,
				} as unknown as DashboardDerived
			}
			timeSeries={[]}
			monitorSamples={[]}
		/>
	);
}

/** The tile for a label, as the figure and the box around it. */
function tile(label: string) {
	const box = screen.getByText(label, { exact: true }).parentElement as HTMLElement;
	return { box, figure: box.querySelector("p.font-bold") as HTMLElement };
}

const isDanger = (label: string) => {
	const { box, figure } = tile(label);
	return box.className.includes("status-error") || figure.className.includes("status-error");
};
const isWarning = (label: string) => {
	const { box, figure } = tile(label);
	return box.className.includes("status-stopped") || figure.className.includes("status-stopped");
};

describe("PerformanceTab latency tiles against the SLO", () => {
	// A Settings SLO no case reads: one that leaked in would colour the cases it
	// sits under and neutralise the ones it sits over.
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: 1 });
	});

	it("leaves every tile neutral when the run is inside the SLO", () => {
		renderTab({ p95: 2.5, p99: 3, p999: 3.5 });

		for (const label of ["P95", "P99", "P999"]) {
			expect(isDanger(label), `${label} danger`).toBe(false);
			expect(isWarning(label), `${label} warning`).toBe(false);
			expect(tile(label).figure.className).toContain("text-foreground");
		}
	});

	it("keeps a tile at exactly the SLO neutral - the SLO is a limit, not a floor", () => {
		renderTab({ p95: 200, p99: 200 });

		expect(isDanger("P99")).toBe(false);
		expect(isWarning("P95")).toBe(false);
	});

	it("paints P95 warning and P99 / P999 danger once each exceeds the SLO", () => {
		renderTab({ p95: 250, p99: 900, p999: 1500 });

		expect(isWarning("P95")).toBe(true);
		expect(isDanger("P95")).toBe(false);
		expect(isDanger("P99")).toBe(true);
		expect(isDanger("P999")).toBe(true);
	});

	it("judges each tile on its own value", () => {
		renderTab({ p95: 150, p99: 250, p999: 250 });

		expect(isWarning("P95")).toBe(false);
		expect(isDanger("P99")).toBe(true);
	});

	it("reads the run's SLO, in both directions", () => {
		const { unmount } = renderTab({ p95: 2.5, p99: 3 }, 2);
		expect(isDanger("P99")).toBe(true);
		unmount();

		renderTab({ p95: 2.5, p99: 3 }, 5);
		expect(isDanger("P99")).toBe(false);
	});

	it("leaves every tile neutral for a run with no SLO, however slow and whatever Settings holds", () => {
		renderTab({ p95: 250, p99: 900, p999: 1500 }, null);

		for (const label of ["P95", "P99", "P999"]) {
			expect(isDanger(label), `${label} danger`).toBe(false);
			expect(isWarning(label), `${label} warning`).toBe(false);
			expect(tile(label).figure.className).toContain("text-foreground");
		}
	});

	it("never colours the tiles that carry no verdict, however slow", () => {
		renderTab({ avg: 5000, p50: 5000, p75: 5000, p90: 5000, p95: 1, p99: 1 });

		for (const label of ["Average", "P50 (Median)", "P75", "P90"]) {
			expect(isDanger(label), `${label} danger`).toBe(false);
			expect(isWarning(label), `${label} warning`).toBe(false);
			expect(tile(label).figure.className).toContain("text-foreground");
		}
	});
});
