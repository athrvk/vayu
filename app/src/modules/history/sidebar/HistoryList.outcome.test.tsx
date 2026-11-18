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
 * Finding the runs that failed (#3547).
 *
 * The verdict is asked of the engine (`outcome=`), because `completed` does not
 * say a budget held and no status filter could list the failures, and re-applied
 * over the loaded rows, so a row whose verdict changed in place leaves the list
 * without a refetch.
 *
 * Mutation check: stop passing the outcome to `useRunsQuery` and the
 * `outcome=failed` case reddens; leave it out of `isNarrowed` or the Clear
 * handler and the empty-state cases redden; drop the client-side pass in
 * `filterRuns` and the rows case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useHistoryStore } from "@/modules/history/history-store";
import HistoryList from "./HistoryList";

/** What the list asked the engine for, per render. */
const runsQueryCalls: { outcome: string | undefined }[] = [];

const queryState = { rows: [] as unknown[] };

vi.mock("@/queries", () => ({
	useRunsQuery: (
		_q?: string,
		_pinnedOnly = false,
		_origin?: string,
		_type?: string,
		_status?: string,
		outcome?: string
	) => {
		runsQueryCalls.push({ outcome });
		return {
			data: {
				pages: [
					{
						data: queryState.rows,
						pagination: {
							total: queryState.rows.length,
							limit: 50,
							offset: 0,
							hasMore: false,
							returned: queryState.rows.length,
						},
					},
				],
				pageParams: [0],
			},
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

function row(id: string, outcome?: "passed" | "failed" | "not_judged") {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: 1,
		...(outcome && { outcome }),
		summary: { url: `http://${id}.test/` },
	};
}

const lastQuery = () => runsQueryCalls[runsQueryCalls.length - 1];
const outcomeSelect = () => screen.getByRole("combobox", { name: "Outcome" });

function choose(name: string) {
	fireEvent.click(outcomeSelect());
	fireEvent.click(screen.getByRole("option", { name }));
}

beforeEach(() => {
	runsQueryCalls.length = 0;
	useHistoryStore.getState().resetFilters();
	queryState.rows = [row("f1", "failed"), row("p1", "passed"), row("n1", "not_judged")];
});

describe("the history sidebar's outcome filter", () => {
	it("asks the engine for every outcome until one is chosen", () => {
		renderList();
		expect(lastQuery().outcome).toBeUndefined();
		expect(outcomeSelect()).toHaveTextContent("All outcomes");
	});

	it("offers the three verdicts after any, in the order a reader hunts them", () => {
		renderList();
		fireEvent.click(outcomeSelect());
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
			"All outcomes",
			"Failed",
			"Not judged",
			"Passed",
		]);
	});

	it("sends outcome=failed to the engine once Failed is chosen", () => {
		renderList();
		choose("Failed");
		expect(lastQuery().outcome).toBe("failed");
		expect(useHistoryStore.getState().filterOutcome).toBe("failed");
	});

	it("sends the engine's spelling of Not judged", () => {
		renderList();
		choose("Not judged");
		expect(lastQuery().outcome).toBe("not_judged");
	});

	it("shows only the rows that wear the chosen verdict", () => {
		renderList();
		choose("Failed");
		expect(screen.getByText("row-f1")).toBeInTheDocument();
		expect(screen.queryByText("row-p1")).not.toBeInTheDocument();
		expect(screen.queryByText("row-n1")).not.toBeInTheDocument();
	});

	it("leaves the Status select as it was", () => {
		renderList();
		choose("Passed");
		expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("All statuses");
		expect(useHistoryStore.getState().filterStatus).toBe("all");
	});

	it("is cleared with the rest from the empty state", () => {
		queryState.rows = [];
		renderList();
		choose("Failed");
		expect(screen.getByText(/Try widening the search/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
		expect(useHistoryStore.getState().filterOutcome).toBe("all");
		expect(lastQuery().outcome).toBeUndefined();
		expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
	});
});
