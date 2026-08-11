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
 * The Server Vitals summary panel (issue #491).
 *
 * Rendered through `PerformanceTab` rather than on its own, because the half
 * that was missing was the *reading*: the engine has written this section since
 * #475 and the tab drew nothing from it. A panel test that never goes through
 * the tab would pass with the tab still ignoring the section.
 *
 * `runId` is left off so `HistoricalChartsSection` (uPlot, canvas) stays out of
 * the tree - the summary is what is under test, and it is deliberately not
 * gated on the chart having anything to draw.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";
import PerformanceTab from "./PerformanceTab";

const DERIVED = { mode: "constant_concurrency", targetRps: 0 } as unknown as DashboardDerived;

function reportWith(monitor?: RunReport["monitor"]): RunReport {
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
		...(monitor ? { monitor } : {}),
	} as unknown as RunReport;
}

function renderTab(monitor?: RunReport["monitor"]) {
	return render(
		<PerformanceTab
			report={reportWith(monitor)}
			derived={DERIVED}
			timeSeries={[]}
			monitorSamples={[]}
		/>
	);
}

describe("the Server Vitals summary on a stored run", () => {
	it("prints each series' min, avg and max when the run recorded them", () => {
		renderTab({
			samples: 60,
			failures: 0,
			series: {
				cpu_percent: { min: 4, max: 91.5, avg: 42.25, count: 60 },
				heap_bytes: { min: 1.2e9, max: 3.4e9, avg: 2e9, count: 60 },
			},
		});

		expect(screen.getByText("Server Vitals Summary")).toBeTruthy();
		expect(screen.getByText("cpu_percent")).toBeTruthy();
		expect(screen.getByText("heap_bytes")).toBeTruthy();
		// The chart's own formatter, not a second spelling of the same numbers.
		expect(screen.getByText("91.5")).toBeTruthy();
		expect(screen.getByText("42.3")).toBeTruthy();
		expect(screen.getByText("3.40G")).toBeTruthy();
		expect(screen.getByText(/over 60 scrapes/i)).toBeTruthy();
	});

	it("draws no panel for a run that monitored nothing", () => {
		// Absent section = absent panel, as everywhere else - a run that scraped
		// no endpoint did not measure a target reporting zeros.
		renderTab(undefined);
		expect(screen.queryByText("Server Vitals Summary")).toBeNull();
	});

	it("says every scrape failed rather than showing an empty panel", () => {
		renderTab({ samples: 0, failures: 12, series: {} });

		expect(screen.getByText(/every scrape failed/i)).toBeTruthy();
		expect(screen.getByText(/12 of 12/)).toBeTruthy();
	});

	it("counts the failures beside the readings when only some scrapes failed", () => {
		renderTab({
			samples: 8,
			failures: 2,
			series: { cpu_percent: { min: 1, max: 2, avg: 1.5, count: 8 } },
		});

		expect(screen.getByText(/2 of 10 scrapes failed/i)).toBeTruthy();
		expect(screen.getByText("cpu_percent")).toBeTruthy();
	});

	it("names the case where scrapes succeeded but carried none of the metrics", () => {
		// `samples > 0` with no series is a live endpoint whose body never held
		// the requested names - which is a typo in the metric name, not an outage,
		// and reads identically to one on the chart.
		renderTab({ samples: 30, failures: 0, series: {} });

		expect(screen.getByText(/none carried the metrics this run asked for/i)).toBeTruthy();
		expect(screen.queryByText(/every scrape failed/i)).toBeNull();
	});

	it("shows a series' own reading count only when it lags the run's", () => {
		// A metric present in 3 of 60 scrapes draws a sparse line; the count is
		// what explains it. An equal count says nothing, so it is not printed.
		const { unmount } = renderTab({
			samples: 60,
			failures: 0,
			series: { cpu_percent: { min: 1, max: 2, avg: 1.5, count: 3 } },
		});
		expect(screen.getByText("3 of 60")).toBeTruthy();
		unmount();

		renderTab({
			samples: 60,
			failures: 0,
			series: { cpu_percent: { min: 1, max: 2, avg: 1.5, count: 60 } },
		});
		expect(screen.queryByText("60 of 60")).toBeNull();
	});
});
