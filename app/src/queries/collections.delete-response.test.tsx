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
 * Deleting a request has to take its response with it.
 *
 * `response-store` is keyed by request id and nothing evicted from it: both of
 * its clearing actions had zero callers, so a session accumulated every
 * response it had ever rendered - body plus raw copy - including for requests
 * that had since been deleted.
 *
 * The tab seam (`closeTabsForEntities`) covers the tree's delete flows, and
 * this covers the delete itself: it is the mutation, not the tab, that makes
 * the response unreachable, and a caller that deletes without touching tabs
 * would otherwise leak the entry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDeleteRequestMutation } from "./collections";
import { useResponseStore } from "@/stores/response-store";

const deleteRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		deleteRequest: (...a: unknown[]) => deleteRequest(...a),
	},
}));

const wrapper = (client: QueryClient) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};

const storeResponse = (requestId: string) =>
	useResponseStore.getState().setResponse(requestId, {
		status: 200,
		statusText: "OK",
		headers: {},
		body: "{}",
		bodyType: "json",
		size: 2,
		time: 1,
	});

beforeEach(() => {
	deleteRequest.mockReset();
	useResponseStore.getState().clearAll();
});

describe("useDeleteRequestMutation", () => {
	it("drops the deleted request's stored response", async () => {
		deleteRequest.mockResolvedValue(undefined);
		storeResponse("req_1");
		storeResponse("req_2");

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useDeleteRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("req_1");

		await waitFor(() => {
			expect(useResponseStore.getState().getResponse("req_1")).toBeNull();
		});
		expect(useResponseStore.getState().getResponse("req_2")).not.toBeNull();
	});

	it("keeps the response when the delete fails", async () => {
		// onSuccess only. A failed delete leaves the request alive, and its
		// response is still the one the user is looking at.
		deleteRequest.mockRejectedValue(new Error("database is locked"));
		storeResponse("req_1");

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useDeleteRequestMutation(), {
			wrapper: wrapper(client),
		});
		await expect(result.current.mutateAsync("req_1")).rejects.toThrow("database is locked");

		expect(useResponseStore.getState().getResponse("req_1")).not.toBeNull();
	});
});
