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
 * A scenario load run's failed assertions on the Overview (#2820).
 *
 * The audit's run answered every request 200 and failed all 4,580 assertions:
 * Success rate read 100.0%, the error rate 0.0%, and nothing on screen said an
 * assertion had failed. The Success rate stays the HTTP figure; the failures
 * get a tile beside it and a block of their own.
 *
 * Mutation-check: drop `<AssertionsSummary>` from `OverviewTab.tsx` and the
 * block cases fail; make `RunKeyMetrics` ignore `scenario.assertions` and the
 * tile and grid cases fail; drop the `total <= 0` guard in
 * `AssertionsSummary.tsx` and the zero-total case fails; read a failure rate
 * off `passed` instead of the total and the partial-failure case fails.
 */

import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// The percentages come from Intl.NumberFormats built at module load, which the
// per-case `stubNumberLocale` below cannot reach, so the locale is pinned before
// the imports run rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import { stubNumberLocale } from "@/test/number-locale";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

type Scenario = NonNullable<RunReport["scenario"]>;

function scenarioReport(assertions?: Scenario["assertions"]): RunReport {
	const scenario: Scenario = {
		iterations: 100,
		iterationsCompleted: 100,
		stepsExecuted: 4_580,
		passed: 4_580,
		failed: 0,
		skipped: 0,
		errored: 0,
		stepsStored: 0,
		stepsDropped: 0,
		virtualUsers: 10,
		...(assertions ? { assertions } : {}),
	};
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 3_000,
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 50 },
		},
		summary: {
			totalRequests: 4_580,
			successfulRequests: 4_580,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 1_526,
		},
		latency: { min: 1, max: 900, avg: 20, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		scenario,
	};
}

function renderTab(report: RunReport) {
	return render(
		withQueryClient(
			<OverviewTab
				report={report}
				runId="run_1"
				derived={reportToDerived(report)}
				anomalies={[]}
			/>
		)
	);
}

/** The Assertions block, or null: the title is also a key-metric tile's label. */
function assertionsCard(): HTMLElement | null {
	const title = screen.queryByText("Assertions", { selector: '[data-slot="card-title"]' });
	return title?.closest<HTMLElement>('[data-slot="card"]') ?? null;
}

function keyMetricsGrid(): HTMLElement {
	return screen.getByText("Success rate").closest<HTMLElement>(".grid")!;
}

describe("a scenario load run whose every assertion failed", () => {
	const report = () => scenarioReport({ passed: 0, failed: 4_580 });
	let restoreLocale: () => void;
	beforeEach(() => {
		restoreLocale = stubNumberLocale("en-US");
	});
	afterEach(() => restoreLocale());

	it("shows the HTTP success rate and the failed count side by side", () => {
		renderTab(report());

		const metrics = within(keyMetricsGrid());
		expect(metrics.getByText("100.0%")).toBeInTheDocument();
		expect(metrics.getByText("4,580 failed")).toBeInTheDocument();
	});

	it("gives the failed count its own tile, on a four-column container grid", () => {
		renderTab(report());

		const grid = keyMetricsGrid();
		expect(grid).toHaveClass("@md:grid-cols-4");
		expect(grid).not.toHaveClass("@md:grid-cols-3");
		const count = within(grid).getByText("4,580 failed");
		expect(count).toHaveClass("text-destructive-text");
	});

	it("draws the Assertions block with the exact tally, and says it covers every response", () => {
		renderTab(report());

		const card = within(assertionsCard()!);
		expect(card.getByText("Counted on every response")).toBeInTheDocument();
		expect(card.getByText("Passed").nextElementSibling).toHaveTextContent("0");
		expect(card.getByText("Failed").nextElementSibling).toHaveTextContent("4,580");
		expect(card.getByText("Failure rate").nextElementSibling).toHaveTextContent("100.0%");
	});
});

describe("a scenario load run that failed some assertions", () => {
	it("states the failure rate against everything it counted", () => {
		renderTab(scenarioReport({ passed: 90, failed: 10 }));

		const card = within(assertionsCard()!);
		expect(card.getByText("Passed").nextElementSibling).toHaveTextContent("90");
		expect(card.getByText("Failure rate").nextElementSibling).toHaveTextContent("10.0%");
	});
});

describe("a scenario load run with nothing failed", () => {
	it("keeps the block, with no fourth tile and the three-column grid", () => {
		renderTab(scenarioReport({ passed: 10, failed: 0 }));

		const card = within(assertionsCard()!);
		expect(card.getByText("Failed").nextElementSibling).toHaveTextContent("0");
		expect(card.getByText("Failure rate").nextElementSibling).toHaveTextContent("0.0%");
		expect(keyMetricsGrid()).toHaveClass("@md:grid-cols-3");
		expect(screen.queryByText(/\d failed$/)).toBeNull();
	});
});

describe("a run with no assertion tally to show", () => {
	it("is absent when the run counted none", () => {
		renderTab(scenarioReport({ passed: 0, failed: 0 }));

		expect(assertionsCard()).toBeNull();
		expect(keyMetricsGrid()).toHaveClass("@md:grid-cols-3");
	});

	it("is absent for a report stored before the tally existed", () => {
		renderTab(scenarioReport());

		expect(assertionsCard()).toBeNull();
		expect(screen.queryByText("Counted on every response")).toBeNull();
		expect(keyMetricsGrid()).toHaveClass("@md:grid-cols-3");
	});

	it("is absent for a report with no scenario section at all", () => {
		const { scenario: _scenario, ...single } = scenarioReport({ passed: 0, failed: 5 });
		renderTab(single as RunReport);

		expect(assertionsCard()).toBeNull();
	});
});
