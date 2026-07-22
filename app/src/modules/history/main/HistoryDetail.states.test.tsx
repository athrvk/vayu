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
const reportQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch,
};

vi.mock("@/queries", () => ({
	useRunReportQuery: () => reportQuery,
}));

// The detail routers render heavy chart trees that are irrelevant here; the
// question is only which of the three panes HistoryDetail chooses.
vi.mock("./LoadTestDetail", () => ({
	default: () => <div data-testid="load-test-detail" />,
}));
vi.mock("./DesignRunDetail", () => ({
	default: () => <div data-testid="design-run-detail" />,
}));

beforeEach(() => {
	refetch.mockClear();
	reportQuery.data = undefined;
	reportQuery.isLoading = false;
	reportQuery.error = null;
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
		reportQuery.error = new Error("engine unreachable");
		render(<HistoryDetail />);

		expect(screen.getByText(/couldn't load this run/i)).toBeTruthy();
		// The raw reason is worth showing in a developer tool: "failed to fetch"
		// and a 500 lead to different next steps.
		expect(screen.getByText(/engine unreachable/i)).toBeTruthy();

		const retry = screen.getByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("treats a settled-but-empty report as an error, not as content", () => {
		// The query resolves `undefined` with no error when the run is gone.
		// Falling through to a detail view would render a report that isn't there.
		render(<HistoryDetail />);

		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
		expect(screen.queryByTestId("load-test-detail")).toBeNull();
	});
});
