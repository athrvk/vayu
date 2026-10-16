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
 * The "Stream events" card on the Performance tab of a finished streaming run
 * - what the dashboard's report showed and History's did not (#2220). The
 * engine omits `report.stream` for every run that did not stream, so the card
 * is gated on the section and an ordinary run's tab must not claim "0 events".
 *
 * Mutation-check: drop the card from `PerformanceTab.tsx` and the first case
 * fails; render it without the `report.stream` gate and the absent case fails.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import PerformanceTab from "./PerformanceTab";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

const STREAM: NonNullable<RunReport["stream"]> = {
	completions: 4,
	totalEvents: 1200,
	capped: 0,
	eventsPerSecond: 300,
	events: { min: 250, max: 350, p50: 300, p90: 330, p95: 340, p99: 350, count: 4 },
};

function makeReport(stream?: RunReport["stream"]): RunReport {
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
		stream,
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

describe("PerformanceTab stream events card", () => {
	it("shows what the streams delivered, under the card's heading", () => {
		renderTab(makeReport(STREAM));

		expect(screen.getByText(/^Stream events/)).toBeInTheDocument();
		expect(screen.getByText("events/sec").previousSibling).toHaveTextContent("300.0");
		expect(screen.getByText("events").previousSibling).toHaveTextContent("1,200");
		expect(
			screen.getByText("Every stream was closed by the server - no cap was reached.")
		).toBeInTheDocument();
	});

	it("is absent from a run that did not stream", () => {
		renderTab(makeReport());

		expect(screen.queryByText(/^Stream events/)).toBeNull();
		expect(screen.queryByText("events/sec")).toBeNull();
	});
});
