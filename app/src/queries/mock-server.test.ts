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
 * `useMockActivityQuery` reads a running mock's activity log. The one thing
 * worth a test here: it stays disabled, and never calls the service at all,
 * when there is no mock id yet - the same guard `useMockServerRoutesQuery`
 * carries, for the same reason (a surface that calls the hook unconditionally
 * before a mock has started).
 *
 * `useMockServerRoutesQuery` polls too, unlike the route *table* it also
 * reads: the table's shape (paths, methods, examples) is a start-time
 * snapshot that cannot change under a running mock, but each route's `hits`
 * changes live as traffic arrives - the engine's own `GET /mock/:id/routes`
 * says so explicitly. A query with no `refetchInterval` fetches exactly once
 * on mount, so the mock server page's hit counts froze at whatever they were
 * when the tab was opened until something else happened to invalidate the
 * query - read by a user as "hits show up after a delay".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useMockActivityQuery, useMockServerRoutesQuery } from "./mock-server";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";
import { TIMING } from "@/config/timing";
import type { MockActivityEntry, MockServerRoute } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		listMockServerActivity: vi.fn(),
		listMockServerRoutes: vi.fn(),
	},
}));

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client }, children);
}

const entry: MockActivityEntry = {
	at: 1_700_000_000_000,
	method: "GET",
	path: "/pets/1",
	requestId: "req_1",
	requestName: "Get pet",
	exampleId: "exa_1",
	exampleName: "200 OK",
	status: 200,
	injectedError: false,
};

const route: MockServerRoute = {
	requestId: "req_1",
	requestName: "List pets",
	method: "GET",
	path: "/pets",
	hasExample: true,
	status: 200,
	mode: "first",
	exampleName: "Default",
	hits: 0,
};

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.mocked(apiService.listMockServerActivity).mockReset().mockResolvedValue([entry]);
	vi.mocked(apiService.listMockServerRoutes).mockReset().mockResolvedValue([route]);
});

describe("useMockActivityQuery", () => {
	it("reads a mock's activity log under its id-scoped key", async () => {
		const { result } = renderHook(() => useMockActivityQuery("mock_1"), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(apiService.listMockServerActivity).toHaveBeenCalledWith("mock_1");
		expect(client.getQueryData(queryKeys.mockServer.activity("mock_1"))).toEqual([entry]);
	});

	it("stays disabled, and never calls the service, without a mock id", () => {
		const { result } = renderHook(() => useMockActivityQuery(null), { wrapper });

		expect(result.current.fetchStatus).toBe("idle");
		expect(apiService.listMockServerActivity).not.toHaveBeenCalled();
	});
});

describe("useMockServerRoutesQuery", () => {
	it("stays disabled, and never calls the service, without a mock id", () => {
		const { result } = renderHook(() => useMockServerRoutesQuery(null), { wrapper });

		expect(result.current.fetchStatus).toBe("idle");
		expect(apiService.listMockServerRoutes).not.toHaveBeenCalled();
	});

	it("polls for fresh hit counts rather than fetching the table once", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { result } = renderHook(() => useMockServerRoutesQuery("mock_1"), { wrapper });
			await waitFor(() => expect(result.current.isSuccess).toBe(true));
			expect(apiService.listMockServerRoutes).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS);
			await waitFor(() => expect(apiService.listMockServerRoutes).toHaveBeenCalledTimes(2));
		} finally {
			vi.useRealTimers();
		}
	});
});
