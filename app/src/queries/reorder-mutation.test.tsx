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
 * The optimistic half of a drop (issue #365).
 *
 * A drag is only believable if the row is where the pointer left it *before*
 * the write returns, and only trustworthy if it goes back when the write fails.
 * Both are cache behaviour, so both are pinned here rather than left to the
 * gesture work in #367.
 *
 * Each test is mutation-checked in the same shape: remove the `onMutate` draw
 * and the first group reddens; remove the `onError` restore and the second
 * group reddens; remove the `onSettled` invalidation and the third does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useReorderMutation } from "./collections";
import { queryKeys } from "./keys";
import { useSaveStore } from "@/stores/save-store";
import type { Collection, Request, ReorderRequest } from "@/types";

const reorder = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		reorder: (...a: unknown[]) => reorder(...a),
	},
}));

const req = (id: string, collectionId: string, order: number): Request =>
	({ id, collectionId, name: id, order, createdAt: "2026-01-01T00:00:00.000Z" }) as Request;

const col = (id: string, order: number, parentId?: string): Collection =>
	({ id, name: id, order, parentId, createdAt: "2026-01-01T00:00:00.000Z" }) as Collection;

function makeClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** `col_a` holds a, b, c; `col_b` holds x. Two root collections alongside. */
function seed(client: QueryClient) {
	client.setQueryData(queryKeys.requests.listByCollection("col_a"), [
		req("a", "col_a", 0),
		req("b", "col_a", 1),
		req("c", "col_a", 2),
	]);
	client.setQueryData(queryKeys.requests.listByCollection("col_b"), [req("x", "col_b", 0)]);
	client.setQueryData(queryKeys.collections.list(), [col("col_a", 0), col("col_b", 1)]);
	client.setQueryData(queryKeys.requests.detail("a"), req("a", "col_a", 0));
}

/** Ids of a collection's cached requests, in cache order. */
const ids = (client: QueryClient, collectionId: string) =>
	(client.getQueryData<Request[]>(queryKeys.requests.listByCollection(collectionId)) ?? []).map(
		(r) => r.id
	);

/** A within-collection swap of the first two requests. */
const swapPlan: ReorderRequest = {
	moves: [
		{ type: "request", id: "b", order: 0 },
		{ type: "request", id: "a", order: 1 },
	],
	normalize: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	useSaveStore.setState({ status: "idle" });
});

describe("useReorderMutation draws the drop before the write returns", () => {
	it("reorders the cached list while the request is still in flight", async () => {
		let release: (value: unknown) => void = () => {};
		reorder.mockImplementation(() => new Promise((resolve) => (release = resolve)));
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		result.current.mutate(swapPlan);

		// The assertion that matters: this is true *before* the mock resolves.
		await waitFor(() => expect(ids(client, "col_a")).toEqual(["b", "a", "c"]));
		release({ collections: [], requests: [] });
	});

	it("moves a request between list caches and updates its detail entry", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({
			moves: [
				{ type: "request", id: "a", order: 0, collectionId: "col_b" },
				{ type: "request", id: "x", order: 1 },
				{ type: "request", id: "b", order: 0 },
				{ type: "request", id: "c", order: 1 },
			],
			normalize: [],
		});

		expect(ids(client, "col_a")).toEqual(["b", "c"]);
		expect(ids(client, "col_b")).toEqual(["a", "x"]);
		// The detail cache carries `staleTime: Infinity`, so a stale
		// `collectionId` there outlives every refetch the tree performs.
		expect(client.getQueryData<Request>(queryKeys.requests.detail("a"))?.collectionId).toBe(
			"col_b"
		);
	});

	it("renumbers a normalized scope dense in display order", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		// The legacy shape: every row at 0, position living only in the tiebreak.
		client.setQueryData(queryKeys.requests.listByCollection("col_a"), [
			req("a", "col_a", 0),
			req("b", "col_a", 0),
			req("c", "col_a", 0),
		]);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({
			moves: [],
			normalize: [{ type: "request", collectionId: "col_a" }],
		});

		expect(
			client
				.getQueryData<Request[]>(queryKeys.requests.listByCollection("col_a"))
				?.map((r) => r.order)
		).toEqual([0, 1, 2]);
	});

	it("reparents a collection and renumbers its new scope", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		client.setQueryData(queryKeys.collections.list(), [
			col("col_a", 0),
			col("col_b", 1),
			col("col_c", 0, "col_a"),
		]);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({
			moves: [{ type: "collection", id: "col_c", order: 0, parentId: null }],
			normalize: [],
		});

		const stored = client
			.getQueryData<Collection[]>(queryKeys.collections.list())
			?.find((c) => c.id === "col_c");
		expect(stored?.parentId).toBeUndefined();
		expect(stored?.order).toBe(0);
	});
});

describe("useReorderMutation settles on the rows the engine wrote", () => {
	it("takes the engine's positions over the ones it drew", async () => {
		// The client guessed 0/1; the engine normalized to 4/5 (a scope it found
		// denser than the client's cache knew). The tree must show the engine's.
		reorder.mockResolvedValue({
			collections: [],
			requests: [req("b", "col_a", 4), req("a", "col_a", 5)],
		});
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync(swapPlan);

		const rows = client.getQueryData<Request[]>(queryKeys.requests.listByCollection("col_a"));
		expect(rows?.find((r) => r.id === "b")?.order).toBe(4);
		expect(rows?.find((r) => r.id === "a")?.order).toBe(5);
	});
});

describe("useReorderMutation rolls back a failed drop", () => {
	it("restores every touched cache and reports through failSave", async () => {
		reorder.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await expect(result.current.mutateAsync(swapPlan)).rejects.toThrow("engine said no");

		expect(ids(client, "col_a")).toEqual(["a", "b", "c"]);
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("puts a cross-collection move back in its source list", async () => {
		reorder.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await expect(
			result.current.mutateAsync({
				moves: [{ type: "request", id: "a", order: 0, collectionId: "col_b" }],
				normalize: [],
			})
		).rejects.toThrow();

		expect(ids(client, "col_a")).toEqual(["a", "b", "c"]);
		expect(ids(client, "col_b")).toEqual(["x"]);
		expect(client.getQueryData<Request>(queryKeys.requests.detail("a"))?.collectionId).toBe(
			"col_a"
		);
	});
});

describe("useReorderMutation invalidates only what the plan touched", () => {
	it("invalidates both sides of a cross-collection move and nothing else", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seed(client);
		client.setQueryData(queryKeys.requests.listByCollection("col_untouched"), []);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({
			moves: [{ type: "request", id: "a", order: 0, collectionId: "col_b" }],
			normalize: [],
		});

		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_a"))?.isInvalidated
		).toBe(true);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_b"))?.isInvalidated
		).toBe(true);
		// A request-only plan must not invalidate the collections list, and must
		// not reach a collection it never named.
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_untouched"))
				?.isInvalidated
		).toBe(false);
		expect(client.getQueryState(queryKeys.collections.list())?.isInvalidated).toBe(false);
	});

	it("invalidates the collections list for a collection move", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({
			moves: [{ type: "collection", id: "col_b", order: 0 }],
			normalize: [],
		});

		expect(client.getQueryState(queryKeys.collections.list())?.isInvalidated).toBe(true);
	});
});
