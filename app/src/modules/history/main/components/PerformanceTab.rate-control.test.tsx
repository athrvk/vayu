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
 * The Rate control tiles on a finished run's Performance tab. Under the
 * achievement percentage sits the plan it is a share of - requests sent over
 * requests owed - for a report the engine stored with those counts (#2392). A
 * report stored before has the percentage alone and draws no line.
 *
 * Mutation-check: drop the `requestsSent` / `requestsExpected` line from
 * `PerformanceTab.tsx` and the first case fails; render it unconditionally and
 * the old-report and zero-expected cases fail.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import PerformanceTab from "./PerformanceTab";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

function makeReport(rateControl: RunReport["rateControl"]): RunReport {
	return {
		metadata: { runId: "run_1", runType: "load", status: "completed" },
		summary: { totalRequests: 100, failedRequests: 0, testDuration: 10, errorRate: 0 },
		latency: { min: 1, max: 9, avg: 4, p50: 4, p90: 7, p95: 8, p99: 9 },
		rateControl,
	} as unknown as RunReport;
}

// `runId` is left off so the uPlot charts stay out of the tree.
function renderTab(report: RunReport) {
	return render(
		<PerformanceTab
			report={report}
			derived={{ mode: "constant_rps", targetRps: 100 } as unknown as DashboardDerived}
			timeSeries={[]}
			monitorSamples={[]}
		/>
	);
}

const SENT_LINE = /sent \/.* expected/;

describe("PerformanceTab rate control tiles", () => {
	it("states the requests sent and expected under the achievement percentage", () => {
		renderTab(
			makeReport({
				targetRps: 100,
				actualRps: 99,
				achievement: 99,
				requestsSent: 1980,
				requestsExpected: 2000,
			})
		);

		const line = screen.getByText(SENT_LINE);
		expect(line.textContent).toMatch(/^1,?980 sent \/ 2,?000 expected$/);
		expect(line.previousElementSibling?.textContent).toMatch(/99(\.\d+)?%/);
	});

	it("draws the percentage alone for a report stored without the counts", () => {
		renderTab(makeReport({ targetRps: 100, actualRps: 99, achievement: 99 }));

		expect(screen.getByText("Achievement rate")).toBeInTheDocument();
		expect(screen.queryByText(SENT_LINE)).toBeNull();
	});

	it("draws no plan when nothing was owed", () => {
		renderTab(
			makeReport({
				targetRps: 100,
				actualRps: 99,
				achievement: 99,
				requestsSent: 40,
				requestsExpected: 0,
			})
		);

		expect(screen.queryByText(SENT_LINE)).toBeNull();
	});

	it("keeps the achievement percentage on the semantic text colour", () => {
		renderTab(
			makeReport({
				targetRps: 100,
				actualRps: 50,
				achievement: 50,
				requestsSent: 1000,
				requestsExpected: 2000,
			})
		);

		const pct = screen.getByText(SENT_LINE).previousElementSibling!;
		expect(pct.className).toContain("text-destructive-text");
	});
});
