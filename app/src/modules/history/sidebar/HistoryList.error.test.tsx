/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A failed fetch must not look like an empty history.
 *
 * `useRunsQuery` is destructured as `{ data: allRuns = [] }`, and nothing sets
 * `throwOnError`, so a query that settles as an error never reaches the
 * ErrorBoundary - it resolves to `[]` and falls through to "No test runs
 * found", a claim about the user's data made when no data arrived.
 *
 * Unlike the collections tree there is no create CTA here to make things worse.
 * The reason is symmetry: the drawer has three sibling views, and one reporting
 * a failed load while the others say the user has nothing makes a single event
 * look like two.
 *
 * Every case asserts both halves - the right thing present *and* the wrong
 * thing absent - because the empty state lives in a separate `{cond && ...}`
 * block, so nothing stops both from rendering at once unless the branch says so.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import HistoryList from "./HistoryList";

const refetch = vi.fn();
const queryState = {
	runs: {
		data: [] as unknown[],
		isLoading: false,
		isError: false,
		error: null as Error | null,
		refetch,
	},
};

vi.mock("@/queries", () => ({
	useRunsQuery: () => queryState.runs,
	useDeleteRunMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Stubbed so a fixture run only needs the fields `filterRuns` reads. RunItem's
// own rendering is not what these cases are about.
vi.mock("./RunItem", () => ({
	default: ({ run }: { run: { id: string } }) => <div>run-{run.id}</div>,
}));

const failed = {
	data: [] as unknown[],
	isLoading: false,
	isError: true,
	error: new Error("Failed to fetch"),
	refetch,
};

function renderList() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<HistoryList />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	refetch.mockReset();
	queryState.runs = { data: [], isLoading: false, isError: false, error: null, refetch };
});

describe("HistoryList when the runs query fails", () => {
	it("says the load failed instead of that there is nothing", () => {
		queryState.runs = failed;
		renderList();

		expect(screen.getByText(/couldn't load run history/i)).toBeInTheDocument();
		expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
		expect(screen.queryByText("No test runs found")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Run your first load test to see its results here.")
		).not.toBeInTheDocument();
	});

	it("offers a way out, and retrying refetches", () => {
		queryState.runs = failed;
		renderList();

		screen.getByRole("button", { name: /try again/i }).click();
		expect(refetch).toHaveBeenCalled();
	});

	it("keeps a working list when a background refetch fails", () => {
		// TanStack keeps the last good data through a failed refetch. Replacing
		// a populated list with an error pane takes away more than it says.
		queryState.runs = {
			data: [{ id: "r1", type: "load", status: "completed", startTime: 1 }],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		renderList();

		expect(screen.getByText("run-r1")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load run history/i)).not.toBeInTheDocument();
	});

	it("still shows the empty state when the query simply returned nothing", () => {
		renderList();

		expect(screen.getByText("No test runs found")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load run history/i)).not.toBeInTheDocument();
	});
});
