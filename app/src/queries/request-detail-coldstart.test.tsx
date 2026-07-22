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
 * A restored tab must find its request on a cold start.
 *
 * `openTabs` is persisted, so on launch every restored request tab calls
 * `useRequestQuery` immediately - before anything has fetched a collection's
 * request list. The old implementation only *read* the cache: detail cache,
 * then the `requests.lists()` caches, then throw. So on a cold start it threw,
 * retried 3× at 100ms, and gave up.
 *
 * The part that made it permanent rather than transient: `staleTime: Infinity`
 * parks the error, so when `usePrefetchCollectionsAndRequests` finally filled
 * those lists a second later, nothing re-ran. The tab showed "Request not
 * found" until you clicked the request in the sidebar again.
 *
 * These tests start from a genuinely empty QueryClient - no seeding - because
 * seeding the cache reproduces the state *after* the race, which is the one
 * case that always worked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRequestQuery } from "./collections";
import { queryKeys } from "./keys";

const listCollections = vi.fn();
const listRequests = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listCollections: (...a: unknown[]) => listCollections(...a),
		listRequests: (...a: unknown[]) => listRequests(...a),
	},
}));

const REQ = {
	id: "req_2",
	collectionId: "col_b",
	name: "Get user",
	method: "GET",
	url: "https://example.test/user",
};

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	listCollections.mockReset();
	listRequests.mockReset();
	listCollections.mockResolvedValue([{ id: "col_a" }, { id: "col_b" }]);
	listRequests.mockImplementation(({ collectionId }: { collectionId: string }) =>
		Promise.resolve(collectionId === "col_b" ? [REQ] : [{ id: "req_1", collectionId: "col_a" }])
	);
});

describe("cold start, nothing cached", () => {
	it("finds the request instead of reporting it missing", async () => {
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.data).toMatchObject({ id: "req_2", name: "Get user" });
		expect(result.current.isError).toBe(false);
	});

	it("fetches the lists itself rather than waiting for a prefetch", async () => {
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(listCollections).toHaveBeenCalled();
		expect(listRequests).toHaveBeenCalledWith({ collectionId: "col_b" });
	});

	it("hydrates the shared list cache, so the sidebar does not refetch", async () => {
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(client.getQueryData(queryKeys.requests.listByCollection("col_b"))).toEqual([REQ]);
	});
});

describe("when the request really is gone", () => {
	it("errors, so the pane can say so honestly", async () => {
		listRequests.mockResolvedValue([]);
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_gone"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
	});
});

describe("resilience", () => {
	it("one unreadable collection does not hide a request in another", async () => {
		listRequests.mockImplementation(({ collectionId }: { collectionId: string }) =>
			collectionId === "col_a" ? Promise.reject(new Error("boom")) : Promise.resolve([REQ])
		);
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.data).toMatchObject({ id: "req_2" });
	});

	it("still prefers the cache and makes no network call when already loaded", async () => {
		const client = makeClient();
		client.setQueryData(queryKeys.requests.listByCollection("col_b"), [REQ]);

		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(listCollections).not.toHaveBeenCalled();
		expect(listRequests).not.toHaveBeenCalled();
	});

	it("is disabled without an id", () => {
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery(null), {
			wrapper: wrapper(client),
		});
		expect(result.current.fetchStatus).toBe("idle");
		expect(listCollections).not.toHaveBeenCalled();
	});
});
