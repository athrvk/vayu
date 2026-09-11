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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useMockActivityQuery } from "./mock-server";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";
import type { MockActivityEntry } from "@/types";

vi.mock("@/services/api", () => ({
	apiService: {
		listMockServerActivity: vi.fn(),
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

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.mocked(apiService.listMockServerActivity).mockReset().mockResolvedValue([entry]);
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
