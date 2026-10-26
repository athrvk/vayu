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
 * A row re-renders only when something about that row changed (#2980).
 *
 * `RunItem` is memoised, which holds only while every prop keeps its identity
 * across the list's own re-renders: the handlers the list passes, and the `run`
 * objects the query hands it. Both are cases here, through the real query
 * layer rather than a stub, because TanStack's structural sharing is what keeps
 * an unchanged run the same object across a poll.
 *
 * A row's render is counted by the one pure helper it calls once per render
 * for a row with a url (`truncateUrl`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { apiService } from "@/services/api";
import { useHistoryStore } from "@/modules/history/history-store";
import { useTabsStore } from "@/stores";
import { truncateUrl } from "@/lib/truncate-url";
import type { Run, RunListResponse } from "@/types";
import HistoryList from "./HistoryList";

vi.mock("@/lib/truncate-url", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/truncate-url")>();
	return { ...actual, truncateUrl: vi.fn(actual.truncateUrl) };
});

// The collections tree is not what these cases are about, and the real query
// would call the engine.
vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return { ...actual, useCollectionsQuery: () => ({ data: [] }) };
});

const rowRenders = vi.mocked(truncateUrl);

/** Older by a minute per `age`, so the sort has an order to change. */
function run(id: string, age = 0): Run {
	return {
		id,
		type: "load",
		status: "completed",
		startTime: Date.now() - age * 60_000,
		requestId: `req_${id}`,
		environmentId: null,
		summary: { url: `http://${id}.test/` },
	} as Run;
}

function envelope(runs: Run[]): RunListResponse {
	return {
		// Fresh objects on every call, as a refetch's JSON parse produces.
		data: structuredClone(runs),
		pagination: {
			total: runs.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: runs.length,
			nextBefore: null,
		},
	};
}

let serverRuns: Run[];
let queryClient: QueryClient;

beforeEach(() => {
	serverRuns = [run("r1", 1), run("r2", 2), run("r3", 3)];
	vi.spyOn(apiService, "listRuns").mockImplementation(async () => envelope(serverRuns));
	useHistoryStore.getState().resetFilters();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function renderList() {
	render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<HistoryList />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole("button", { name: /Open Load test, completed, http:\/\/r3/ });
	rowRenders.mockClear();
}

describe("the history list's rows re-render only for their own changes", () => {
	it("leaves every row alone when the sort reorders them", async () => {
		await renderList();
		const names = () => screen.getAllByRole("button", { name: /^Open Load test/ });
		expect(names()[0]).toHaveAccessibleName(/http:\/\/r1/);

		// Sort is client-side (a filter would ask the engine and replace the
		// rows): the list re-renders with the same runs, moved.
		act(() => useHistoryStore.getState().setSortBy("oldest"));

		expect(names()[0]).toHaveAccessibleName(/http:\/\/r3/);
		expect(rowRenders).not.toHaveBeenCalled();
	});

	it("re-renders only the row that became selected", async () => {
		await renderList();

		act(() => useTabsStore.getState().openTab({ type: "run", entityId: "r2" }));

		expect(rowRenders).toHaveBeenCalledTimes(1);
	});

	it("renders only the run a poll changed", async () => {
		await renderList();

		serverRuns = [serverRuns[0], { ...serverRuns[1], status: "failed" }, serverRuns[2]];
		await act(() => queryClient.refetchQueries({ queryKey: ["runs"] }));
		await screen.findByRole("button", { name: /Open Load test, failed, http:\/\/r2/ });

		expect(rowRenders).toHaveBeenCalledTimes(1);
	});

	it("keeps the rows mounted when a run lands at the head of their day", async () => {
		await renderList();
		const before = screen.getByRole("button", { name: /http:\/\/r2/ });

		serverRuns = [run("r0"), ...serverRuns];
		await act(() => queryClient.refetchQueries({ queryKey: ["runs"] }));
		await screen.findByRole("button", { name: /http:\/\/r0/ });

		// Same node: a group keyed by its first run would remount all of them.
		expect(screen.getByRole("button", { name: /http:\/\/r2/ })).toBe(before);
	});

	it("renders no row when a poll brings back the same runs", async () => {
		await renderList();

		await act(() => queryClient.refetchQueries({ queryKey: ["runs"] }));
		await waitFor(() => expect(apiService.listRuns).toHaveBeenCalledTimes(2));

		expect(rowRenders).not.toHaveBeenCalled();
	});
});
