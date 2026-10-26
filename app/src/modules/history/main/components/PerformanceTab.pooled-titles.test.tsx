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
 * The Performance tab's latency cards fold every step of a sequence into one
 * distribution, so their titles say "(all steps)" for a scenario load run and
 * only for one (#2823).
 *
 * Mutation-check: pass `pooled` as always true and the single-request case
 * fails; as always false and the sequence case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import type { RunReport, RunScenarioStepStat } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

vi.mock("@/modules/dashboard/components/charts/uplot", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/dashboard/components/charts/uplot")>()),
	HdrPercentileChart: () => null,
}));

const PerformanceTab = (await import("./PerformanceTab")).default;

const STEP: RunScenarioStepStat = {
	index: 0,
	name: "Log in",
	requestId: "req_a",
	method: "POST",
	executed: 40,
	errors: 0,
	latency: { min: 1, p50: 4, p95: 9, p99: 12, max: 30 },
};

function renderTab(steps?: RunScenarioStepStat[]) {
	const report = {
		metadata: { runId: "run_1", runType: "load", status: "completed" },
		summary: { totalRequests: 40, failedRequests: 0, requestsPerSecond: 10, testDuration: 4 },
		latency: { min: 1, max: 30, avg: 5, p50: 4, p90: 8, p95: 9, p99: 12 },
		...(steps ? { scenario: { steps } } : {}),
	} as unknown as RunReport;
	return render(
		<PerformanceTab
			report={report}
			derived={{ mode: "constant_concurrency", targetRps: 0 } as unknown as DashboardDerived}
			timeSeries={[]}
			monitorSamples={[]}
		/>
	);
}

describe("PerformanceTab pooled titles", () => {
	it("marks the latency distribution as all steps for a sequence", () => {
		renderTab([STEP]);

		expect(screen.getByText("Latency distribution (all steps)")).toBeTruthy();
	});

	it("leaves a single-request run's title alone", () => {
		renderTab();

		expect(screen.getByText("Latency distribution")).toBeTruthy();
		expect(screen.queryByText(/all steps/)).toBeNull();
	});
});
