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

function run(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1,
		baseline: false,
		summary: { url: `http://${id}.test/` },
		...over,
	};
}

/** The most recent `useRunsQuery` call - `.at` is past this project's lib. */
function lastQuery() {
	return runsQueryCalls[runsQueryCalls.length - 1];
}

function pinnedToggle() {
	return screen.getByRole("button", { name: /pinned/i });
}

beforeEach(() => {
	runsQueryCalls.length = 0;
	useHistoryStore.getState().resetFilters();
	queryState.rows = [run("pinned1", { baseline: true }), run("plain1")];
});

describe("the history sidebar's pinned filter", () => {
	it("lists every run until the filter is turned on", () => {
		renderList();

		expect(lastQuery().pinnedOnly).toBe(false);
		expect(screen.getByText("row-pinned1")).toBeInTheDocument();
		expect(screen.getByText("row-plain1")).toBeInTheDocument();
		expect(pinnedToggle()).toHaveAttribute("aria-pressed", "false");
	});

	it("asks the engine for pinned runs only once toggled on", () => {
		renderList();
		fireEvent.click(pinnedToggle());

		// The engine is asked a different question, rather than the same list
		// being sieved - a pin older than the loaded pages has to be findable.
		expect(lastQuery().pinnedOnly).toBe(true);
		expect(pinnedToggle()).toHaveAttribute("aria-pressed", "true");
	});

	it("turns back off, restoring the unfiltered list", () => {
		renderList();
		fireEvent.click(pinnedToggle());
		fireEvent.click(pinnedToggle());

		expect(lastQuery().pinnedOnly).toBe(false);
		expect(screen.getByText("row-plain1")).toBeInTheDocument();
	});

	/*
	 * Unpinning patches the loaded pages in place (`useSetRunBaselineMutation`)
	 * instead of refetching them, so a row the engine would no longer return is
	 * still in the cache with `baseline: false`. Leaving it on screen would make
	 * the pinned list disagree with itself until the next poll.
	 */
	it("drops a row that was unpinned while the filter was on", () => {
		renderList();
		fireEvent.click(pinnedToggle());

		expect(screen.getByText("row-pinned1")).toBeInTheDocument();
		expect(screen.queryByText("row-plain1")).not.toBeInTheDocument();
	});

	it("says what an empty pinned list means, rather than offering the search advice", () => {
		queryState.rows = [];
		renderList();
		fireEvent.click(pinnedToggle());

		expect(screen.getByText("No pinned runs found")).toBeInTheDocument();
		expect(screen.getByText(/Pin a run as its request's baseline/i)).toBeInTheDocument();
	});

	it("keeps the widen-your-search advice when a search is also narrowing the list", () => {
		queryState.rows = [];
		useHistoryStore.getState().setSearchQuery("nothing-matches");
		renderList();
		fireEvent.click(pinnedToggle());

		expect(screen.getByText(/Try widening the search/i)).toBeInTheDocument();
	});
});
