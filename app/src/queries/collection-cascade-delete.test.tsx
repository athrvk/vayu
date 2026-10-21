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
 * Deleting a collection deletes a subtree, and the client cannot know its
 * shape.
 *
 * The engine cascade-deletes descendant collections and every request under
 * them. The mutation used to filter one id out of the collections list and
 * invalidate one collection's request list, which leaves descendants in the
 * cache feeding `useCollectionAncestors` and the resolver, and leaves
 * `requests.detail` entries fresh forever (`staleTime: Infinity`).
 *
 * "Fresh" is the assertion that matters here, not "absent": invalidation is
 * what makes the next read go back to the engine, so `getQueryState().isInvalidated`
 * is the thing a revert flips, while `getQueryData` looks identical either way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDeleteCollectionMutation, useCreateCollectionMutation } from "./collections";
import { queryKeys } from "./keys";
import type { Collection } from "@/types";

const deleteCollection = vi.fn();
const createCollection = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		deleteCollection: (...a: unknown[]) => deleteCollection(...a),
		createCollection: (...a: unknown[]) => createCollection(...a),
	},
}));

const col = (id: string, parentId?: string): Collection =>
	({ id, name: id, parentId, variables: {} }) as unknown as Collection;

function makeClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => vi.clearAllMocks());

describe("deleting a collection invalidates the whole cascade", () => {
	it("leaves no descendant collection or request cache entry fresh", async () => {
		deleteCollection.mockResolvedValue(undefined);
		const client = makeClient();
		// A two-level tree: deleting `root` takes `child` and both request lists
		// with it, engine-side.
		client.setQueryData(queryKeys.collections.list(), [col("root"), col("child", "root")]);
		client.setQueryData(queryKeys.requests.listByCollection("root"), [{ id: "r1" }]);
		client.setQueryData(queryKeys.requests.listByCollection("child"), [{ id: "r2" }]);
		client.setQueryData(queryKeys.requests.detail("r2"), { id: "r2" });

		const { result } = renderHook(() => useDeleteCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("root");

		// The descendant's caches: stale, so the next read asks the engine
		// instead of serving a row the engine deleted. Reverting to
		// `invalidateQueries(listByCollection(deletedId))` leaves all three valid.
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("child"))?.isInvalidated
		).toBe(true);
		expect(client.getQueryState(queryKeys.requests.detail("r2"))?.isInvalidated).toBe(true);
		expect(client.getQueryState(queryKeys.collections.list())?.isInvalidated).toBe(true);

		// The deleted collection itself still goes from the list immediately, so
		// the tree does not wait for a refetch to stop showing it.
		expect(client.getQueryData(queryKeys.collections.list())).toEqual([col("child", "root")]);
	});

	it("does not invalidate anything when the delete fails", async () => {
		deleteCollection.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();
		client.setQueryData(queryKeys.requests.detail("r2"), { id: "r2" });

		const { result } = renderHook(() => useDeleteCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await expect(result.current.mutateAsync("root")).rejects.toThrow("engine said no");

		expect(client.getQueryState(queryKeys.requests.detail("r2"))?.isInvalidated).toBe(false);
	});
});

describe("deleting a collection refetches every request list", () => {
	it("re-runs the warm-cache pass, so the lists join one workspace call", async () => {
		// Not a `setQueryData` patch: patching needs the subtree the engine took,
		// and that is engine-side knowledge (see above).
		deleteCollection.mockResolvedValue(undefined);
		const client = makeClient();
		client.setQueryData(queryKeys.prefetch.allRequests(), true);

		const { result } = renderHook(() => useDeleteCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("root");

		expect(client.getQueryState(queryKeys.prefetch.allRequests())?.isInvalidated).toBe(true);
	});
});

describe("creating a collection", () => {
	it("seeds its empty request list and leaves every other list alone", async () => {
		createCollection.mockResolvedValue(col("new"));
		const client = makeClient();
		client.setQueryData(queryKeys.collections.list(), []);
		client.setQueryData(queryKeys.prefetch.allRequests(), true);
		client.setQueryData(queryKeys.requests.listByCollection("other"), [{ id: "r1" }]);

		const { result } = renderHook(() => useCreateCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ name: "new" });

		expect(client.getQueryData(queryKeys.requests.listByCollection("new"))).toEqual([]);
		// Mutation check: invalidate the pass on create again and this reds - a
		// workspace-wide request read for a collection that holds nothing.
		expect(client.getQueryState(queryKeys.prefetch.allRequests())?.isInvalidated).toBe(false);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("other"))?.isInvalidated
		).toBe(false);
	});
});
