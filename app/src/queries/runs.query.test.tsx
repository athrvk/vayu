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
 * The runs list is a paginated, filtered server query, not a client-side scan.
 *
 * - `useLastDesignRunQuery` must ask the server for exactly one row
 *   (`requestId` + `type=design` + `status=completed` + `limit=1`) and trust
 *   its start_time DESC order - no download-the-whole-list-and-filter.
 * - `useRecentDesignRunsQuery` asks the same way for the last few, and
 *   deliberately without the status filter - see its case below.
 * - `useRunsQuery` is an infinite query over the `{data, pagination}` envelope:
 *   `fetchNextPage` advances the offset, and `flattenRunPages` de-dupes rows
 *   that a head insertion can momentarily place in two refetched pages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	useLastDesignRunQuery,
	useRecentDesignRunsQuery,
	RECENT_DESIGN_RUN_LIMIT,
	useRunsQuery,
	flattenRunPages,
	runsPollInterval,
	runDetailOptions,
	useDeleteRunMutation,
	RunNotFoundError,
	isRunNotFound,
} from "./runs";
import { queryKeys } from "./keys";
import { ApiError } from "@/services";
import type { RunListResponse } from "@/types";

const listRuns = vi.fn();
const getRunReport = vi.fn();
const getRun = vi.fn();
const deleteRun = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRuns: (...a: unknown[]) => listRuns(...a),
		getRunReport: (...a: unknown[]) => getRunReport(...a),
		getRun: (...a: unknown[]) => getRun(...a),
		deleteRun: (...a: unknown[]) => deleteRun(...a),
	},
}));

function page(rows: RunListResponse["data"], over: Partial<RunListResponse["pagination"]> = {}) {
	return {
		data: rows,
		pagination: {
			total: rows.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: rows.length,
			...over,
		},
	} satisfies RunListResponse;
}

function makeClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	listRuns.mockReset();
	getRunReport.mockReset();
	getRun.mockReset();
	deleteRun.mockReset();
});

function runRow(id: string) {
	return { id, type: "load", status: "completed", startTime: 1, endTime: 2 } as const;
}

describe("useLastDesignRunQuery", () => {
	it("issues one filtered single-run call, not a full-list scan", async () => {
		listRuns.mockResolvedValue(
			page([{ id: "run_9", type: "design", status: "completed", startTime: 5, endTime: 6 }])
		);
		getRunReport.mockResolvedValue({ summary: {}, latency: {} });

		const { result } = renderHook(() => useLastDesignRunQuery("req_1"), {
			wrapper: wrapper(makeClient()),
		});

		await waitFor(() => expect(result.current.run?.id).toBe("run_9"));
		expect(listRuns).toHaveBeenCalledTimes(1);
		expect(listRuns).toHaveBeenCalledWith({
			requestId: "req_1",
			type: "design",
			status: "completed",
			limit: 1,
		});
	});

	it("does not fetch when there is no request id", () => {
		renderHook(() => useLastDesignRunQuery(null), { wrapper: wrapper(makeClient()) });
		expect(listRuns).not.toHaveBeenCalled();
	});
});

describe("useRecentDesignRunsQuery", () => {
	it("asks for one page of this request's design runs, with no status filter", async () => {
		// No `status`: it takes one value, so filtering to `completed` would
		// hide every failed send - which is most of what a trend is read for.
		listRuns.mockResolvedValue(page([runRow("run_9")]));

		const { result } = renderHook(() => useRecentDesignRunsQuery("req_1"), {
			wrapper: wrapper(makeClient()),
		});

		await waitFor(() => expect(result.current.data?.data[0].id).toBe("run_9"));
		expect(listRuns).toHaveBeenCalledTimes(1);
		expect(listRuns).toHaveBeenCalledWith({
			requestId: "req_1",
			type: "design",
			limit: RECENT_DESIGN_RUN_LIMIT,
		});
	});

	it("does not fetch when there is no request id", () => {
		renderHook(() => useRecentDesignRunsQuery(null), { wrapper: wrapper(makeClient()) });
		expect(listRuns).not.toHaveBeenCalled();
	});

	it("keys itself outside the infinite-list prefix, like the last-design lookup", () => {
		// It caches a plain `RunListResponse`, and the delete-run patch walks
		// everything under `lists()` as `InfiniteData` - the exact shape clash
		// that made `lastDesign` its own family.
		const lists = queryKeys.runs.lists() as readonly unknown[];
		const recent = queryKeys.runs.recentDesign("req_1") as readonly unknown[];
		expect(recent.slice(0, lists.length)).not.toEqual([...lists]);
		// ...and under the prefix a delete *does* invalidate, so a deleted run
		// cannot linger in a section keyed by a request the delete never saw.
		const family = queryKeys.runs.recentDesigns() as readonly unknown[];
		expect(recent.slice(0, family.length)).toEqual([...family]);
	});
});

describe("useRunsQuery", () => {
	it("paginates: fetchNextPage advances the offset off the envelope", async () => {
		listRuns.mockImplementation(({ offset }: { offset: number }) =>
			offset === 0
				? Promise.resolve(
						page(
							[
								{
									id: "a",
									type: "load",
									status: "completed",
									startTime: 2,
									endTime: 3,
								},
							],
							{
								total: 2,
								hasMore: true,
								offset: 0,
							}
						)
					)
				: Promise.resolve(
						page(
							[
								{
									id: "b",
									type: "load",
									status: "completed",
									startTime: 1,
									endTime: 2,
								},
							],
							{
								total: 2,
								hasMore: false,
								offset: 50,
							}
						)
					)
		);

		const { result } = renderHook(() => useRunsQuery(), { wrapper: wrapper(makeClient()) });

		await waitFor(() => expect(result.current.data?.pages.length).toBe(1));
		expect(result.current.hasNextPage).toBe(true);

		await result.current.fetchNextPage();
		await waitFor(() => expect(result.current.data?.pages.length).toBe(2));
		expect(result.current.hasNextPage).toBe(false);
		// Second call requested offset = first offset + limit.
		expect(listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }));
		expect(flattenRunPages(result.current.data).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("passes a trimmed search as the q param, omitting a blank one", async () => {
		listRuns.mockResolvedValue(page([]));

		renderHook(() => useRunsQuery("  users  "), { wrapper: wrapper(makeClient()) });
		await waitFor(() => expect(listRuns).toHaveBeenCalled());
		expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ q: "users" }));

		listRuns.mockClear();
		renderHook(() => useRunsQuery("   "), { wrapper: wrapper(makeClient()) });
		await waitFor(() => expect(listRuns).toHaveBeenCalled());
		expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
	});
});

describe("flattenRunPages", () => {
	it("de-dupes by id across pages, keeping the first occurrence", () => {
		const data = {
			pages: [
				page([{ id: "x", type: "load", status: "completed", startTime: 3, endTime: 4 }]),
				page([
					{ id: "x", type: "load", status: "completed", startTime: 3, endTime: 4 },
					{ id: "y", type: "load", status: "completed", startTime: 2, endTime: 3 },
				]),
			],
			pageParams: [0, 50],
		};
		expect(flattenRunPages(data).map((r) => r.id)).toEqual(["x", "y"]);
	});

	it("is empty for undefined", () => {
		expect(flattenRunPages(undefined)).toEqual([]);
	});
});

/**
 * The delete-run patch walks *every* cache under the `runs.lists()` prefix and
 * treats each as `InfiniteData`. `useLastDesignRunQuery` caches a plain
 * `RunListResponse`, and `RequestBuilderProvider` mounts it for every open
 * request tab - so with one request tab open, deleting a run threw a TypeError
 * inside the mutation's own `onSuccess`: the engine had deleted the run, but the
 * row lingered, the all-runs patch and the report eviction never ran, and the
 * user saw "Couldn't delete run".
 *
 * Fixed at the root (its own key family) with a shape guard as the belt. The
 * three tests below pin the two halves separately, so reverting either is red.
 */
describe("useDeleteRunMutation with a foreign cache shape under the runs prefix", () => {
	function seededClient() {
		const client = makeClient();
		client.setQueryData(queryKeys.runs.list({ q: undefined }), {
			pages: [page([runRow("r1"), runRow("r2")], { total: 2 })],
			pageParams: [0],
		});
		client.setQueryData(queryKeys.runs.allRuns(), [runRow("r1"), runRow("r2")]);
		return client;
	}

	it("keys the last-design-run lookup outside the infinite-list prefix", () => {
		const lists = queryKeys.runs.lists() as readonly unknown[];
		const lastDesign = queryKeys.runs.lastDesign("req_1") as readonly unknown[];
		// Not a prefix match: `setQueriesData({queryKey: lists()})` must not reach it.
		expect(lastDesign.slice(0, lists.length)).not.toEqual([...lists]);
	});

	it("deletes cleanly with a last-design-run cache present, and patches every cache", async () => {
		const client = seededClient();
		client.setQueryData(queryKeys.runs.report("r1"), { summary: {} });
		deleteRun.mockResolvedValue(undefined);

		// Populated by the hook itself, not by hand - what an open request tab
		// leaves in the cache is only wrong if the *hook* keys it under
		// `lists()`, so the hook is what has to write it.
		listRuns.mockResolvedValue(page([runRow("r1")]));
		getRunReport.mockResolvedValue({ summary: {} });
		const design = renderHook(() => useLastDesignRunQuery("req_1"), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(design.result.current.run?.id).toBe("r1"));

		const { result } = renderHook(() => useDeleteRunMutation(), {
			wrapper: wrapper(client),
		});

		await result.current.mutateAsync("r1");

		const list = client.getQueryData(queryKeys.runs.list({ q: undefined })) as {
			pages: RunListResponse[];
		};
		expect(list.pages[0].data.map((r) => r.id)).toEqual(["r2"]);
		expect(list.pages[0].pagination.total).toBe(1);
		// The two patches that used to be skipped because the first one threw.
		expect(client.getQueryData(queryKeys.runs.allRuns())).toEqual([runRow("r2")]);
		expect(client.getQueryData(queryKeys.runs.report("r1"))).toBeUndefined();
	});

	it("leaves a non-paged cache under the list prefix alone instead of throwing on it", async () => {
		const client = seededClient();
		// The pre-fix key, written by hand: the guard is what stops any future
		// plain-shaped cache under this prefix from breaking the delete again.
		const strayKey = queryKeys.runs.list({ requestId: "req_1", limit: 1 });
		client.setQueryData(strayKey, page([runRow("r1")]));
		deleteRun.mockResolvedValue(undefined);

		const { result } = renderHook(() => useDeleteRunMutation(), {
			wrapper: wrapper(client),
		});

		await expect(result.current.mutateAsync("r1")).resolves.toBeUndefined();
		// Untouched - the updater does not know this shape and says so by refusing it.
		expect(client.getQueryData(strayKey)).toEqual(page([runRow("r1")]));
	});
});

/**
 * A deleted run and an unreachable engine are different answers, and a run tab
 * outlives its run (tabs are persisted). Retrying a 404 forever is what the
 * global `retry: 2` did to a zombie tab.
 */
describe("runDetailOptions", () => {
	it("maps only a 404 to RunNotFoundError, rethrowing anything else untouched", async () => {
		const { queryFn } = runDetailOptions("run_1");

		getRun.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "HTTP 404", {}));
		await expect(queryFn()).rejects.toBeInstanceOf(RunNotFoundError);

		const transport = new Error("Network error: engine unreachable");
		getRun.mockRejectedValueOnce(transport);
		await expect(queryFn()).rejects.toBe(transport);
	});

	it("never retries a deletion, but still retries a transport failure", () => {
		const { retry } = runDetailOptions("run_1");

		expect(retry(0, new RunNotFoundError("run_1"))).toBe(false);
		expect(retry(0, new Error("Failed to fetch"))).toBe(true);
	});

	it("discriminates by type, not by message", () => {
		expect(isRunNotFound(new RunNotFoundError("run_1"))).toBe(true);
		expect(isRunNotFound(new Error("Run run_1 no longer exists"))).toBe(false);
	});
});

describe("runsPollInterval", () => {
	it("polls the unpaged list and stops once older pages are loaded", () => {
		// Refetching an infinite query refetches every loaded page, so a user ten
		// pages deep drove ~10 requests per tick.
		expect(runsPollInterval(0)).toBe(5000);
		expect(runsPollInterval(1)).toBe(5000);
		expect(runsPollInterval(2)).toBe(false);
		expect(runsPollInterval(10)).toBe(false);
	});
});
