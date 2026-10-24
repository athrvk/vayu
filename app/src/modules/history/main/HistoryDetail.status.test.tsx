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
 * The run tab's status pill states the run's verdict (#2872).
 *
 * A `completed` load run that missed a budget, or met them but erred, drew the
 * success tick here while its sidebar row and the dashboard header (#2130) drew
 * the alert and the question mark: one status word in two colours, by header.
 * Both branches are asserted - a verdict refines the pill, and a passed run
 * and a non-load run keep the tick.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import HistoryDetail from "./HistoryDetail";
import { useTabsStore } from "@/stores";

const reportQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch: vi.fn(),
};
const runQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch: vi.fn(),
};

vi.mock("@/queries", async () => {
	const runs = await vi.importActual<typeof import("@/queries/runs")>("@/queries/runs");
	return {
		useRunQuery: () => runQuery,
		useRunReportQuery: () => reportQuery,
		isRunNotFound: runs.isRunNotFound,
		useCollectionsQuery: () => ({ data: [] }),
	};
});
vi.mock("./LoadTestDetail", () => ({ default: () => null }));
vi.mock("./DesignRunView", () => ({ default: () => null }));
vi.mock("./ScenarioRunView", () => ({ default: () => null }));
vi.mock("./components/RunExportMenu", () => ({ default: () => null }));

function report(budgetsPassed: boolean | null, errorRate: number) {
	return {
		metadata: { status: "completed" },
		summary: { totalRequests: 100, errorRate },
		thresholdValidation:
			budgetsPassed === null
				? undefined
				: {
						checks: [{ metric: "latencyP99Ms", limit: 100, passed: budgetsPassed }],
						passed: budgetsPassed ? 1 : 0,
						failed: budgetsPassed ? 0 : 1,
						verdict: budgetsPassed ? "passed" : "failed",
					},
	};
}

const pill = () => screen.getByText("Completed").closest("[data-status]")!;

beforeEach(() => {
	reportQuery.data = undefined;
	runQuery.data = { id: "run-1", type: "load", status: "completed" };
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run-1", title: "Run" } as never],
		activeTabId: "t1",
	});
});

describe("HistoryDetail status pill", () => {
	it("draws a missed budget in the error family, not as a success", () => {
		reportQuery.data = report(false, 0);
		render(<HistoryDetail />);
		expect(pill().className).toContain("text-status-error-text");
		expect(pill().className).not.toContain("text-status-success-text");
	});

	it("draws a met-but-errors run as unjudged, in the neutral family", () => {
		reportQuery.data = report(true, 0.078);
		render(<HistoryDetail />);
		expect(pill().className).toContain("text-muted-foreground");
		expect(pill().className).not.toContain("text-status-success-text");
	});

	it("keeps the tick for a run that passed", () => {
		reportQuery.data = report(true, 0);
		render(<HistoryDetail />);
		expect(pill().className).toContain("text-status-success-text");
	});

	it("keeps the tick for a design run, which has no verdict", () => {
		runQuery.data = { id: "run-1", type: "design", status: "completed" };
		render(<HistoryDetail />);
		expect(pill().className).toContain("text-status-success-text");
	});
});
