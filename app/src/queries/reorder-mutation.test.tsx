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
 *
 * A parent's sub-folders and requests are one sibling list (#2535), so a plan
 * over one parent can write both caches - the collections list and the
 * parent's request list - and every pass covers both.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useReorderMutation } from "./collections";
import { queryKeys } from "./keys";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
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

/**
 * `col_p` holds two sub-folders and two requests, every row at the legacy `0`:
 * displayed f1, f2, r1, r2 (folders first on the tie, then createdAt). A root
 * and an unrelated parent's sub-folder sit beside it, also at 0.
 */
function seedLegacyParent(client: QueryClient) {
	const at = (stamp: string) => ({ createdAt: `2026-01-0${stamp}T00:00:00.000Z` });
	client.setQueryData(queryKeys.collections.list(), [
		col("col_p", 0),
		{ ...col("f2", 0, "col_p"), ...at("3") },
		{ ...col("f1", 0, "col_p"), ...at("2") },
		col("col_q", 0),
		col("q_child", 0, "col_q"),
	]);
	client.setQueryData(queryKeys.requests.listByCollection("col_p"), [
		{ ...req("r2", "col_p", 0), ...at("5") },
		{ ...req("r1", "col_p", 0), ...at("1") },
	]);
	client.setQueryData(queryKeys.requests.listByCollection("col_q"), []);
}

/** `id -> order` across the collections list and one request list. */
function ordersOf(client: QueryClient, collectionId: string): Record<string, number> {
	const rows = [
		...(client.getQueryData<Collection[]>(queryKeys.collections.list()) ?? []),
		...(client.getQueryData<Request[]>(queryKeys.requests.listByCollection(collectionId)) ??
			[]),
	];
	return Object.fromEntries(rows.map((row) => [row.id, row.order]));
}

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
	useToastStore.setState({ toasts: [] });
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

	it("renumbers a normalized parent's folders and requests as one list", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seedLegacyParent(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({ moves: [], normalize: [{ parentId: "col_p" }] });

		// One run across both caches, in the order the tree showed them. Rows of
		// other parents keep their 0.
		expect(ordersOf(client, "col_p")).toEqual({
			col_p: 0,
			f1: 0,
			f2: 1,
			r1: 2,
			r2: 3,
			col_q: 0,
			q_child: 0,
		});
	});

	it("renumbers the top level over collections alone", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seedLegacyParent(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({ moves: [], normalize: [{ parentId: null }] });

		expect(ordersOf(client, "col_p")).toEqual({
			col_p: 0,
			f1: 0,
			f2: 0,
			r1: 0,
			r2: 0,
			col_q: 1,
			q_child: 0,
		});
	});

	it("draws a request between two folders into both caches", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seedLegacyParent(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		// r2 to index 1: f1, r2, f2, r1.
		await result.current.mutateAsync({
			normalize: [{ parentId: "col_p" }],
			moves: [
				{ type: "request", id: "r2", order: 1 },
				{ type: "collection", id: "f2", order: 2 },
				{ type: "request", id: "r1", order: 3 },
			],
		});

		expect(ordersOf(client, "col_p")).toMatchObject({ f1: 0, r2: 1, f2: 2, r1: 3 });
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
	it("restores every touched cache and reports through a toast, not the Dock", async () => {
		reorder.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await expect(result.current.mutateAsync(swapPlan)).rejects.toThrow("engine said no");

		expect(ids(client, "col_a")).toEqual(["a", "b", "c"]);
		expect(useToastStore.getState().toasts).toEqual([
			expect.objectContaining({
				message: "Couldn't reorder - engine said no",
				variant: "error",
			}),
		]);
		// The drop was rolled back, so no edit is unsaved: "Not saved" would
		// describe nothing (#1885).
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("reports a non-Error rejection without a reason", async () => {
		reorder.mockRejectedValue("nope");
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await expect(result.current.mutateAsync(swapPlan)).rejects.toBe("nope");

		expect(useToastStore.getState().toasts).toEqual([
			expect.objectContaining({ message: "Couldn't reorder.", variant: "error" }),
		]);
	});

	it("restores both caches a normalized parent drew into", async () => {
		reorder.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();
		seedLegacyParent(client);
		const before = ordersOf(client, "col_p");

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await expect(
			result.current.mutateAsync({
				normalize: [{ parentId: "col_p" }],
				moves: [{ type: "request", id: "r2", order: 0 }],
			})
		).rejects.toThrow();

		expect(ordersOf(client, "col_p")).toEqual(before);
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

	it("invalidates both caches of a normalized parent", async () => {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		seedLegacyParent(client);

		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({ moves: [], normalize: [{ parentId: "col_p" }] });

		expect(client.getQueryState(queryKeys.collections.list())?.isInvalidated).toBe(true);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_p"))?.isInvalidated
		).toBe(true);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_q"))?.isInvalidated
		).toBe(false);
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
