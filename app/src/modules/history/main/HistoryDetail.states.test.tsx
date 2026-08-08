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
 * The run-report pane's three non-content answers.
 *
 * Loading was a bare spinner - the only pane in the app still using one after
 * `DetailSkeleton` landed, so the report header jumped into place instead of
 * resolving into a shape that was already there.
 *
 * The error pane was worse than plain: its single action, "Back to History",
 * walked the user *away* from the run. A transient engine hiccup therefore had
 * no recovery short of re-selecting the run from the drawer, even though the
 * query it failed on exposes a `refetch`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HistoryDetail from "./HistoryDetail";
import { useTabsStore } from "@/stores";

const refetch = vi.fn();
const refetchRun = vi.fn();
const reportQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch,
};
/*
 * The run itself, not only its report. A design run's configuration exists
 * nowhere else - the report has no `metadata.configuration` for one - so the
 * pane fetches both and asks for the report only when the run is a load run.
 */
const runQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch: refetchRun,
};

// `isRunNotFound` is the real one: the pane's whole job here is to discriminate
// a deletion from a transport failure, and a stubbed predicate would assert
// nothing about that.
vi.mock("@/queries", async () => {
	const runs = await vi.importActual<typeof import("@/queries/runs")>("@/queries/runs");
	return {
		useRunQuery: () => runQuery,
		useRunReportQuery: () => reportQuery,
		isRunNotFound: runs.isRunNotFound,
	};
});

// The detail routers render heavy chart trees that are irrelevant here; the
// question is only which of the three panes HistoryDetail chooses.
vi.mock("./LoadTestDetail", () => ({
	default: () => <div data-testid="load-test-detail" />,
}));
vi.mock("./DesignRunView", () => ({
	default: () => <div data-testid="design-run-view" />,
}));
vi.mock("./ScenarioRunView", () => ({
	default: () => <div data-testid="scenario-run-view" />,
}));

beforeEach(() => {
	refetch.mockClear();
	refetchRun.mockClear();
	reportQuery.data = undefined;
	reportQuery.isLoading = false;
	reportQuery.error = null;
	// A settled load run by default, so each test varies only what it is about.
	runQuery.data = { id: "run-1", type: "load", status: "completed" };
	runQuery.isLoading = false;
	runQuery.error = null;
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run-1", title: "Run" } as never],
		activeTabId: "t1",
	});
});

describe("HistoryDetail loading", () => {
	it("shows the detail skeleton, not a spinner", () => {
		reportQuery.isLoading = true;
		render(<HistoryDetail />);

		// role=status + a label naming the pane is DetailSkeleton's contract.
		expect(screen.getByRole("status", { name: /loading run report/i })).toBeTruthy();
	});
});

describe("HistoryDetail error", () => {
	it("offers a retry that refetches, instead of only walking the user away", () => {
		runQuery.error = new Error("engine unreachable");
		runQuery.data = undefined;
		render(<HistoryDetail />);

		expect(screen.getByText(/couldn't load this run/i)).toBeTruthy();
		// The raw reason is worth showing in a developer tool: "failed to fetch"
		// and a 500 lead to different next steps.
		expect(screen.getByText(/engine unreachable/i)).toBeTruthy();

		const retry = screen.getByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		expect(refetchRun).toHaveBeenCalledTimes(1);
	});

	/*
	 * A run tab outlives its run: tabs are persisted, so a run deleted in
	 * another window - or before the last quit - rehydrates into this pane on
	 * launch. Retrying a 404 can only 404 again, which is what the global
	 * `retry: 2` had it doing; the way out is closing the tab.
	 */
	it("says the run is gone and offers the tab close, with no doomed retry", async () => {
		const { RunNotFoundError } = await import("@/queries/runs");
		runQuery.error = new RunNotFoundError("run-1");
		runQuery.data = undefined;
		render(<HistoryDetail />);

		expect(screen.getByText(/this run no longer exists/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /close tab/i }));
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("treats a settled-but-empty report as an error, not as content", () => {
		// The query resolves `undefined` with no error when the run is gone.
		// Falling through to a detail view would render a report that isn't there.
		render(<HistoryDetail />);

		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
		expect(screen.queryByTestId("load-test-detail")).toBeNull();
	});
});

describe("HistoryDetail routing", () => {
	it("renders the detached copy for a design run, and never asks for a report", () => {
		runQuery.data = { id: "run-1", type: "design", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByTestId("design-run-view")).toBeTruthy();
		// The report is a load-test aggregate. A design run must not be gated on
		// one - `reportQuery.data` is undefined here, which used to mean "error".
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("renders the load-test report for a load run", () => {
		reportQuery.data = { metadata: { runType: "load" } };

		render(<HistoryDetail />);

		expect(screen.getByTestId("load-test-detail")).toBeTruthy();
	});

	/*
	 * A scenario run's `results[]` are step executions of different requests, so
	 * `LoadTestDetail`'s percentiles would describe a sequence as though it were
	 * one request repeated. It also must not be gated on the report the way a
	 * load run is: while the sequence is still executing, the live step stream
	 * is the content, and waiting for a report would hold the tab on a skeleton
	 * for the length of the run.
	 */
	it("renders the step list for a scenario run, not the load-test report", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByTestId("scenario-run-view")).toBeTruthy();
		expect(screen.queryByTestId("load-test-detail")).toBeNull();
	});

	it("does not gate a running scenario run on a report it has no reason to have", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "running" };
		reportQuery.data = undefined;
		reportQuery.error = new Error("no report yet");

		render(<HistoryDetail />);

		expect(screen.getByTestId("scenario-run-view")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("names a scenario run a collection run in the header", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByText(/collection run/i)).toBeTruthy();
	});

	it("shows the run id and status without repeating the URL", () => {
		runQuery.data = { id: "run-1", type: "design", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByText("run-1")).toBeTruthy();
		expect(screen.getByText(/completed/i)).toBeTruthy();
		// The builder below owns the URL bar; showing it here too was two of them.
		expect(screen.queryByText(/https:\/\//)).toBeNull();
	});
});
