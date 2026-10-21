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
 * The launch's request lists are one `GET /requests?fields=summary`, not one per
 * collection, and not the whole rows (#2546).
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
import {
	useCreateCollectionMutation,
	useDeleteCollectionMutation,
	useDeleteRequestMutation,
	useMultipleCollectionRequests,
	usePrefetchCollectionsAndRequests,
} from "./collections";
import { useImportMutation } from "./import";
import { invalidateForMcpEvent } from "@/lib/mcp-invalidation";
import { queryKeys } from "./keys";
import { useBindSpecMutation, useSyncSpecMutation } from "./specs";
import { QUERY_CACHE } from "@/config/cache";
import type { Collection, RequestSummary } from "@/types";

const listRequestSummaries = vi.fn();
/** The whole-row list. Nothing here may call it: the tree reads summaries. */
const listRequests = vi.fn(async () => []);
const listCollections = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRequestSummaries: (...a: unknown[]) => listRequestSummaries(...a),
		listRequests: () => listRequests(),
		listCollections: (...a: unknown[]) => listCollections(...a),
		createCollection: vi.fn(async () => collection("c4")),
		deleteCollection: vi.fn(async () => undefined),
		deleteRequest: vi.fn(async () => undefined),
		applyImport: vi.fn(async () => ({ idMap: {} })),
		getGlobals: vi.fn(async () => ({ id: "globals", variables: {}, updatedAt: "0" })),
		updateGlobals: vi.fn(async (variables: unknown) => ({ id: "globals", variables })),
		bindSpec: vi.fn(async () => ({})),
		syncSpec: vi.fn(async () => ({})),
	},
}));

const collection = (id: string) => ({ id, name: id, order: 0 }) as Collection;
const req = (id: string, collectionId: string): RequestSummary => ({
	id,
	collectionId,
	name: id,
	method: "GET",
	url: "",
	order: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
});

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
	listRequestSummaries.mockReset();
	listRequests.mockClear();
	listCollections.mockReset();
	listCollections.mockResolvedValue(COLLECTIONS);
});

describe("the launch's request lists", () => {
	it("are one list call, joined by the tree's per-collection queries while it is in flight", async () => {
		// Mutation check: have the per-collection queries call
		// `apiService.listRequestSummaries({ collectionId })` directly again and
		// this makes one call per collection on top of the launch's one.
		const all = deferred<RequestSummary[]>();
		listRequestSummaries.mockImplementation((params?: { collectionId?: string }) =>
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

		expect(listRequestSummaries).toHaveBeenCalledTimes(1);
		expect(listRequestSummaries.mock.calls[0]).toEqual([]);
		// Mutation check: seed from `apiService.listRequests()` and the launch
		// downloads every body, header set and script in the workspace again.
		expect(listRequests).not.toHaveBeenCalled();
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
		listRequestSummaries.mockResolvedValue(ALL_REQUESTS);
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

		expect(listRequestSummaries).toHaveBeenCalledTimes(1);
		expect(tree.result.current.requestsByCollection.get("parent")).toEqual([]);
		pass.unmount();
		tree.unmount();
	});

	it("refetches just the one collection a later change invalidates", async () => {
		// Once the pass has landed its answer is older than whatever invalidated
		// a list, so that list is fetched on its own rather than read from it.
		listRequestSummaries.mockImplementation((params?: { collectionId?: string }) =>
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

		expect(listRequestSummaries).toHaveBeenCalledTimes(2);
		expect(listRequestSummaries.mock.calls[1]).toEqual([{ collectionId: "c2" }]);
		expect(listRequests).not.toHaveBeenCalled();
	});
});

const THREE = [collection("c1"), collection("c2"), collection("c3")];
const ONE_EACH = [req("r1", "c1"), req("r2", "c2"), req("r3", "c3")];

/** The launch, settled: the pass landed and the tree holds three list observers. */
async function launched() {
	listCollections.mockResolvedValue(THREE);
	listRequestSummaries.mockImplementation((params?: { collectionId?: string }) =>
		Promise.resolve(
			params?.collectionId
				? ONE_EACH.filter((r) => r.collectionId === params.collectionId)
				: ONE_EACH
		)
	);
	const client = newClient();
	renderHook(() => useLaunch(), { wrapper: wrapper(client) });
	await waitFor(() =>
		expect(client.getQueryState(queryKeys.prefetch.allRequests())?.status).toBe("success")
	);
	await waitFor(() => expect(client.isFetching()).toBe(0));
	listRequestSummaries.mockClear();
	return client;
}

/** Waits out whatever the mutation's invalidations refetched. */
async function settle(client: QueryClient) {
	await waitFor(() => expect(listRequestSummaries).toHaveBeenCalled());
	await waitFor(() => expect(client.isFetching()).toBe(0));
}

/**
 * A mutation that invalidates the request lists has to do it through the pass.
 *
 * With the tree mounted, every collection's list is an observer, and each one
 * `invalidateQueries` refetches would put one `GET /requests?collectionId=` per
 * collection on the engine. Invalidating `prefetch.allRequests` first makes
 * them join the one `GET /requests` instead (`invalidateAllRequestLists`).
 */
describe("a mutation that invalidates every request list", () => {
	/** Every call joined the one pass: a single `GET /requests`, never a scoped list. */
	function expectOneWorkspaceCall() {
		expect(listRequestSummaries.mock.calls).toEqual([[]]);
	}

	it("joins one list call when a collection is deleted", async () => {
		const client = await launched();
		const { result } = renderHook(() => useDeleteCollectionMutation(), {
			wrapper: wrapper(client),
		});

		await act(async () => {
			await result.current.mutateAsync("c1");
		});
		await settle(client);

		expectOneWorkspaceCall();
	});

	it("joins one list call when an import settles", async () => {
		const client = await launched();
		const { result } = renderHook(() => useImportMutation(), { wrapper: wrapper(client) });

		await act(async () => {
			await result.current.mutateAsync({
				result: {
					collections: [],
					environments: [],
					globals: {},
					meta: {
						format: "Postman Globals",
						requestCount: 0,
						folderCount: 0,
						environmentCount: 0,
						globalCount: 0,
						exampleCount: 0,
						skipped: [],
						nonExecutableAuth: 0,
						unattachedFileParts: 0,
					},
				},
				opts: { importEnvironments: true, importScripts: true },
			});
		});
		await settle(client);

		expectOneWorkspaceCall();
	});

	it("joins one list call when a spec is bound", async () => {
		const client = await launched();
		const { result } = renderHook(() => useBindSpecMutation(), { wrapper: wrapper(client) });

		await act(async () => {
			await result.current.mutateAsync({ collectionId: "c1", content: "{}" });
		});
		await settle(client);

		expectOneWorkspaceCall();
	});

	it("joins one list call when a spec is synced", async () => {
		const client = await launched();
		const { result } = renderHook(() => useSyncSpecMutation(), { wrapper: wrapper(client) });

		await act(async () => {
			await result.current.mutateAsync({
				collectionId: "c1",
				spec: { content: "{}" },
				collections: [],
				create: [],
				update: [],
				delete: [],
			});
		});
		await settle(client);

		expectOneWorkspaceCall();
	});
});

/**
 * A collection write that changes nothing under the row reads no request list
 * (#2546): an agent looping over collections would otherwise put one
 * workspace-wide `GET /requests` on the engine per call.
 */
describe("a collection write that changes no request", () => {
	it("seeds a created collection's list, so the tree mounting it fetches nothing", async () => {
		const client = await launched();
		const { result } = renderHook(() => useCreateCollectionMutation(), {
			wrapper: wrapper(client),
		});

		await act(async () => {
			await result.current.mutateAsync({ name: "c4" });
		});
		// The tree has mounted the new collection's list.
		await waitFor(() =>
			expect(
				client
					.getQueryCache()
					.find({ queryKey: queryKeys.requests.listByCollection("c4") })
					?.getObserversCount()
			).toBe(1)
		);
		await waitFor(() => expect(client.isFetching()).toBe(0));

		// Mutation check: drop the seed and the mount fetches `{ collectionId: "c4" }`;
		// invalidate the pass on create again and it is a workspace call.
		expect(listRequestSummaries).not.toHaveBeenCalled();
		expect(listRequests).not.toHaveBeenCalled();
	});

	it("fifty agent renames refetch the collections and no request list", async () => {
		const client = await launched();
		listCollections.mockClear();

		act(() => {
			for (let i = 0; i < 50; i++) {
				invalidateForMcpEvent(client, {
					entity: "collectionRow",
					collectionId: THREE[i % THREE.length].id,
				});
			}
		});
		await waitFor(() => expect(listCollections).toHaveBeenCalled());
		await waitFor(() => expect(client.isFetching()).toBe(0));

		// Mutation check: have the `collectionRow` family call
		// `invalidateAllRequestLists` and every rename is a workspace call.
		expect(listRequestSummaries).not.toHaveBeenCalled();
		expect(listRequests).not.toHaveBeenCalled();
	});

	it("leaves a coarse collection event refetching every list, in one call", async () => {
		// A move, an import or a trash restore: the named collection's list is not
		// the only one that changed.
		const client = await launched();

		act(() => {
			invalidateForMcpEvent(client, { entity: "collection", collectionId: "c1" });
		});
		await settle(client);

		expect(listRequestSummaries.mock.calls).toEqual([[]]);
	});
});

describe("deleting a request", () => {
	async function deleteRequest(client: QueryClient, id: string) {
		const { result } = renderHook(() => useDeleteRequestMutation(), {
			wrapper: wrapper(client),
		});
		await act(async () => {
			await result.current.mutateAsync(id);
		});
		await settle(client);
	}

	it("refetches only the owner's list when the detail names it, with no pass", async () => {
		const client = await launched();
		client.setQueryData(queryKeys.requests.detail("r2"), req("r2", "c2"));

		await deleteRequest(client, "r2");

		expect(listRequestSummaries.mock.calls).toEqual([[{ collectionId: "c2" }]]);
		expect(client.getQueryData(queryKeys.requests.detail("r2"))).toBeUndefined();
	});

	it("finds the owner in the list caches when no detail was opened", async () => {
		const client = await launched();

		await deleteRequest(client, "r3");

		expect(listRequestSummaries.mock.calls).toEqual([[{ collectionId: "c3" }]]);
	});

	it("joins one list call when no cache knows the owner", async () => {
		const client = await launched();

		await deleteRequest(client, "unknown");

		expect(listRequestSummaries.mock.calls).toEqual([[]]);
	});
});
