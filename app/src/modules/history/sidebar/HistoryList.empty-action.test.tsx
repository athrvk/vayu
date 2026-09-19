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
 * "No test runs found" offers the undo only when there is something to undo
 * (issue #1693).
 *
 * The description already split on this: with a search or a Select narrowing
 * the list it reads "Try widening the search or clearing the filters", and
 * the action follows the same split. Offering "Clear the filters" to a user
 * whose history is empty because nothing has run yet would be advice for a
 * state they are not in - the case this asserts in both directions.
 */

/**
 * Finding the runs you pinned (#503).
 *
 * The pin has been storable and visible on a row since #472, but there was no
 * way to *list* the pinned runs: the sidebar's filters were type and status
 * only, so finding a baseline meant scrolling history until its pin icon went
 * past. The engine has always answered `GET /runs?baseline=true`.
 *
 * Two halves are pinned here because the filter has two: the param decides
 * which runs are fetched (so a pin older than the loaded pages is reachable),
 * and `filterRuns` decides which of the fetched rows are shown (so unpinning -
 * which patches the loaded pages in place rather than refetching them - drops
 * the row immediately instead of at the next poll).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useHistoryStore } from "@/modules/history/history-store";
import HistoryList from "./HistoryList";

/** What the list asked the engine for, per render. */
const runsQueryCalls: { q: string | undefined; pinnedOnly: boolean }[] = [];

const queryState = { rows: [] as unknown[] };

function infinite(rows: unknown[]) {
	return {
		pages: [
			{
				data: rows,
				pagination: {
					total: rows.length,
					limit: 50,
					offset: 0,
					hasMore: false,
					returned: rows.length,
				},
			},
		],
		pageParams: [0],
	};
}

vi.mock("@/queries", () => ({
	useRunsQuery: (q?: string, pinnedOnly = false) => {
		runsQueryCalls.push({ q, pinnedOnly });
		return {
			data: infinite(queryState.rows),
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
			hasNextPage: false,
			isFetchingNextPage: false,
		};
	},
	useDeleteRunMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useSetRunBaselineMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	flattenRunPages: (d: { pages?: Array<{ data: unknown[] }> } | undefined) =>
		d?.pages?.flatMap((p) => p.data) ?? [],
	runsTotal: (d: { pages?: Array<{ pagination: { total: number } }> } | undefined) =>
		d?.pages?.[0]?.pagination.total ?? 0,
	useCollectionsQuery: () => ({ data: [] }),
}));

// The row is not what these cases are about - it only has to name the run it
// was handed, so a filtered-out row is an absent name rather than a styling
// question.
vi.mock("./RunItem", () => ({
	default: ({ run }: { run: { id: string } }) => <div>row-{run.id}</div>,
}));

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
	runsQueryCalls.length = 0;
	queryState.rows = [];
	useHistoryStore.getState().resetFilters();
});

describe("the history sidebar's empty list", () => {
	it("offers no undo when nothing has run yet", () => {
		renderList();
		expect(screen.getByText("No test runs found")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
	});

	it("clears a search that narrowed the list to nothing", () => {
		renderList();
		fireEvent.change(screen.getByPlaceholderText(/search/i), {
			target: { value: "nothing matches this" },
		});
		expect(screen.getByText("No test runs found")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
		expect(useHistoryStore.getState().searchQuery).toBe("");
		expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
	});
});
