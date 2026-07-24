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
 * - `useRunsQuery` is an infinite query over the `{data, pagination}` envelope:
 *   `fetchNextPage` advances the offset, and `flattenRunPages` de-dupes rows
 *   that a head insertion can momentarily place in two refetched pages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useLastDesignRunQuery, useRunsQuery, flattenRunPages } from "./runs";
import type { RunListResponse } from "@/types";

const listRuns = vi.fn();
const getRunReport = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRuns: (...a: unknown[]) => listRuns(...a),
		getRunReport: (...a: unknown[]) => getRunReport(...a),
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
});

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
