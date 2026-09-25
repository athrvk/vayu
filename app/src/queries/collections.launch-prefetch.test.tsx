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
 * The launch's request lists are one `GET /requests`, not one per collection.
 *
 * The warm-cache pass used to wait for the collections and then fan out one
 * list call per collection - measured on a 300-collection workspace, 312
 * engine requests at launch and ~7s before the burst settled. It is now one
 * call fetched alongside the collections, seeded into every collection's own
 * `listByCollection` entry. The tree mounts its per-collection queries as soon
 * as the collections arrive, which is before that one call lands, so those
 * queries join it rather than each fetching (`requestsForCollection`) - the
 * case these tests drive, by holding the call open while the tree mounts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMultipleCollectionRequests, usePrefetchCollectionsAndRequests } from "./collections";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
import type { Collection, Request } from "@/types";

const listRequests = vi.fn();
const listCollections = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRequests: (...a: unknown[]) => listRequests(...a),
		listCollections: (...a: unknown[]) => listCollections(...a),
	},
}));

const collection = (id: string) => ({ id, name: id, order: 0 }) as Collection;
const req = (id: string, collectionId: string) =>
	({ id, collectionId, name: id, method: "GET", url: "" }) as Request;

const COLLECTIONS = [collection("c1"), collection("c2"), collection("parent")];
const ALL_REQUESTS = [req("r1", "c1"), req("r2", "c1"), req("r3", "c2")];

const wrapper = (client: QueryClient) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};

// The app's own freshness window (`lib/query-client.ts`): a seeded list is
// served from cache for exactly as long as the app would serve it.
const newClient = () =>
	new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: Infinity,
				staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
			},
		},
	});

/** `App` and `CollectionTree` together: the pass, and the tree's lists over its result. */
function useLaunch() {
	const { collections } = usePrefetchCollectionsAndRequests();
	return useMultipleCollectionRequests(collections.map((c) => c.id));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	listRequests.mockReset();
	listCollections.mockReset();
	listCollections.mockResolvedValue(COLLECTIONS);
});

describe("the launch's request lists", () => {
	it("are one list call, joined by the tree's per-collection queries while it is in flight", async () => {
		// Mutation check: have the per-collection queries call
		// `apiService.listRequests({ collectionId })` directly again and this
		// makes one call per collection on top of the launch's one.
		const all = deferred<Request[]>();
		listRequests.mockImplementation((params?: { collectionId?: string }) =>
			params?.collectionId ? Promise.resolve([]) : all.promise
		);

		const { result } = renderHook(() => useLaunch(), { wrapper: wrapper(newClient()) });
		// The collections have arrived and the tree has mounted a query per
		// collection, all while the one list call is still open.
		await waitFor(() => expect(result.current.requestsByCollection.size).toBe(3));
		expect(result.current.isLoading).toBe(true);

		await act(async () => {
			all.resolve(ALL_REQUESTS);
			await all.promise;
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(listRequests).toHaveBeenCalledTimes(1);
		expect(listRequests.mock.calls[0]).toEqual([]);
		expect(result.current.requestsByCollection.get("c1")?.map((r) => r.id)).toEqual([
			"r1",
			"r2",
		]);
		expect(result.current.requestsByCollection.get("c2")?.map((r) => r.id)).toEqual(["r3"]);
		expect(result.current.requestsByCollection.get("parent")).toEqual([]);
	});

	it("seeds a collection with no requests, so a tree mounted afterwards fetches nothing", async () => {
		// A parent folder usually holds no requests of its own; an unseeded key
		// for it would be a list call the moment the tree mounted it.
		listRequests.mockResolvedValue(ALL_REQUESTS);
		const client = newClient();

		const pass = renderHook(() => usePrefetchCollectionsAndRequests(), {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(client.getQueryState(queryKeys.prefetch.allRequests())?.status).toBe("success")
		);
		expect(client.getQueryData(queryKeys.requests.listByCollection("parent"))).toEqual([]);

		const tree = renderHook(() => useMultipleCollectionRequests(["c1", "c2", "parent"]), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(tree.result.current.isLoading).toBe(false));

		expect(listRequests).toHaveBeenCalledTimes(1);
		expect(tree.result.current.requestsByCollection.get("parent")).toEqual([]);
		pass.unmount();
		tree.unmount();
	});

	it("refetches just the one collection a later change invalidates", async () => {
		// Once the pass has landed its answer is older than whatever invalidated
		// a list, so that list is fetched on its own rather than read from it.
		listRequests.mockImplementation((params?: { collectionId?: string }) =>
			Promise.resolve(
				params?.collectionId === "c2" ? [req("r3", "c2"), req("r4", "c2")] : ALL_REQUESTS
			)
		);
		const client = newClient();
		const { result } = renderHook(() => useLaunch(), { wrapper: wrapper(client) });
		await waitFor(() => expect(result.current.requestsByCollection.get("c2")?.length).toBe(1));

		await act(async () => {
			await client.invalidateQueries({ queryKey: queryKeys.requests.listByCollection("c2") });
		});
		await waitFor(() => expect(result.current.requestsByCollection.get("c2")?.length).toBe(2));

		expect(listRequests).toHaveBeenCalledTimes(2);
		expect(listRequests.mock.calls[1]).toEqual([{ collectionId: "c2" }]);
	});
});
