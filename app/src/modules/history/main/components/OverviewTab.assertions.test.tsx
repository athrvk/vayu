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
 * A scenario load run whose every response was a `200` and whose assertions
 * mostly failed (#2820): the Overview shows the exact assertion population next
 * to the HTTP figures that cannot say it. Success rate stays the HTTP one, so
 * 100.0% and the failed count are on screen together.
 *
 * Mutation-check: drop `<ExactAssertionsSummary>` from `OverviewTab.tsx` and the
 * block and rate cases fail; make `RunKeyMetrics` read `scenario.failed` instead
 * of the assertions and the tile cases fail; pass `title` unconditionally and
 * the "absent" case fails, pass it never and the retitle case fails; drop the
 * `> 0` guard on the tile and the zero-failed case fails; switch the grid to
 * four columns unconditionally and the three-column cases fail.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import OverviewTab from "./OverviewTab";
import { withQueryClient } from "@/test/query-wrapper";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import type { RunReport } from "@/types";

vi.mock("@/services/api", () => ({ apiService: {} }));

type Scenario = NonNullable<RunReport["scenario"]>;

function scenario(assertions?: Scenario["assertions"]): Scenario {
	return {
		iterations: 100,
		iterationsCompleted: 100,
		stepsExecuted: 4590,
		passed: 4590,
		failed: 0,
		skipped: 0,
		errored: 0,
		stepsStored: 0,
		stepsDropped: 0,
		virtualUsers: 10,
		assertions,
	};
}

/** Every response a 200 (success rate 100.0%), most assertions failed. */
function makeReport(overrides: Partial<RunReport> = {}): RunReport {
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
			totalRequests: 4590,
			successfulRequests: 4590,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 1530,
		},
		latency: { min: 1, max: 900, avg: 20, p50: 2, p90: 3, p95: 4, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		scenario: scenario({ passed: 12_000, failed: 4_580 }),
		...overrides,
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

const SAMPLED = { samplesTested: 20, testsPassed: 18, testsFailed: 2, successRate: 90 };

/** The tile grid is the Overview's first element. */
function tileGrid(container: HTMLElement): HTMLElement {
	return container.querySelector<HTMLElement>(".grid")!;
}

describe("OverviewTab with exact assertions", () => {
	it("shows 100.0% success and the failed count together", () => {
		const { container } = renderTab(makeReport());
		const grid = tileGrid(container);

		expect(within(grid).getByText("100.0%")).toBeInTheDocument();
		expect(within(grid).getByText("Assertions")).toBeInTheDocument();
		expect(within(grid).getByText("4,580 failed")).toBeInTheDocument();
		expect(grid.className).toContain("@md:grid-cols-4");
		expect(grid.className).not.toContain("@md:grid-cols-3");
	});

	it("draws the Assertions block with passed, failed and the exact failure rate", () => {
		renderTab(makeReport());

		const title = screen.getByText("Assertions", { selector: "[data-slot='card-title']" });
		const card = title.closest("[data-slot='card']") as HTMLElement;
		expect(within(card).getByText("12,000")).toBeInTheDocument();
		expect(within(card).getByText("4,580")).toBeInTheDocument();
		// 4,580 of 16,580.
		expect(within(card).getByText("27.6%")).toBeInTheDocument();
		expect(within(card).getByText(/every response/)).toBeInTheDocument();
	});

	it("retitles the sampled card so the two populations are not both 'Test validation'", () => {
		renderTab(makeReport({ testValidation: SAMPLED }));

		expect(screen.getByText("Sampled replay")).toBeInTheDocument();
		expect(screen.queryByText("Test validation")).toBeNull();
	});
});

describe("OverviewTab without exact assertions", () => {
	it("keeps the three-tile grid, no block and the original card title", () => {
		const { container } = renderTab(
			makeReport({ scenario: scenario(undefined), testValidation: SAMPLED })
		);
		const grid = tileGrid(container);

		expect(grid.className).toContain("@md:grid-cols-3");
		expect(grid.className).not.toContain("@md:grid-cols-4");
		expect(
			screen.queryByText("Assertions", { selector: "[data-slot='card-title']" })
		).toBeNull();
		expect(screen.queryByText("Sampled replay")).toBeNull();
		expect(screen.getByText("Test validation")).toBeInTheDocument();
	});

	it("keeps a single-request report, which has no scenario section, as it was", () => {
		const { container } = renderTab(
			makeReport({ scenario: undefined, testValidation: SAMPLED })
		);

		expect(tileGrid(container).className).toContain("@md:grid-cols-3");
		expect(screen.getByText("Test validation")).toBeInTheDocument();
	});

	it("shows the block but no failed tile when every assertion passed", () => {
		const { container } = renderTab(
			makeReport({ scenario: scenario({ passed: 500, failed: 0 }) })
		);

		expect(tileGrid(container).className).toContain("@md:grid-cols-3");
		expect(within(tileGrid(container)).queryByText(/failed/)).toBeNull();
		const title = screen.getByText("Assertions", { selector: "[data-slot='card-title']" });
		const card = title.closest("[data-slot='card']") as HTMLElement;
		expect(within(card).getByText("0.0%")).toBeInTheDocument();
	});
});
