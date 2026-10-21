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
 * `useMultipleCollectionRequests` must hand back the *same* map while the
 * underlying results are unchanged.
 *
 * It used to build the `Map` inline on every call, so its identity churned on
 * every render of every caller. `CollectionTree` lists it in the dependency
 * array of the effect that reveals the active tab, which therefore re-ran after
 * every render and re-expanded a collection the user had just collapsed. The
 * ref guard in that effect is the fix for the collapse; this is the fix for the
 * churn itself, which also rebuilt `getRequestsByCollection` and every
 * `CollectionItem` prop chain each render.
 *
 * Callers pass a freshly-built id array every render (the tree derives it from
 * the collections query with `.map`), so these tests do the same - a hook that
 * only stays stable for a caller who remembers to memoise its argument would
 * not have fixed anything.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	useCreateRequestMutation,
	useFullCollectionRequests,
	useMultipleCollectionRequests,
} from "./collections";
import { queryKeys } from "./keys";
import type { Request, RequestSummary } from "@/types";

const listRequestSummaries = vi.fn();
const listRequests = vi.fn();
const createRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listRequestSummaries: (...a: unknown[]) => listRequestSummaries(...a),
		listRequests: (...a: unknown[]) => listRequests(...a),
		createRequest: (...a: unknown[]) => createRequest(...a),
	},
}));

const req = (id: string, collectionId: string, extra: Partial<RequestSummary> = {}) =>
	({
		id,
		collectionId,
		name: id,
		method: "GET",
		url: "",
		...extra,
	}) as RequestSummary;

const wrapper = (client: QueryClient) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};

const newClient = () =>
	new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

beforeEach(() => {
	listRequestSummaries.mockReset();
	listRequestSummaries.mockImplementation(({ collectionId }: { collectionId: string }) =>
		Promise.resolve(collectionId === "c1" ? [req("r1", "c1")] : [])
	);
	listRequests.mockReset();
});

describe("useMultipleCollectionRequests", () => {
	it("returns the same map across a re-render with unchanged data", async () => {
		const { result, rerender } = renderHook(
			// A new array literal every render, exactly as CollectionTree builds it.
			() => useMultipleCollectionRequests(["c1", "c2"]),
			{ wrapper: wrapper(newClient()) }
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		const first = result.current.requestsByCollection;
		rerender();
		rerender();

		expect(result.current.requestsByCollection).toBe(first);
	});

	it("returns a new map when the id list changes", async () => {
		const { result, rerender } = renderHook(
			({ ids }: { ids: string[] }) => useMultipleCollectionRequests(ids),
			{ wrapper: wrapper(newClient()), initialProps: { ids: ["c1"] } }
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		const first = result.current.requestsByCollection;

		rerender({ ids: ["c1", "c2"] });
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.requestsByCollection).not.toBe(first);
		expect([...result.current.requestsByCollection.keys()]).toEqual(["c1", "c2"]);
	});

	it("keys every requested collection, sorted by order then createdAt", async () => {
		listRequestSummaries.mockImplementation(({ collectionId }: { collectionId: string }) =>
			Promise.resolve(
				collectionId === "c1"
					? [
							req("late", "c1", { order: 1 }),
							req("older", "c1", { order: 0, createdAt: "2026-01-01T00:00:00Z" }),
							req("newer", "c1", { order: 0, createdAt: "2026-02-01T00:00:00Z" }),
						]
					: []
			)
		);
		const { result } = renderHook(() => useMultipleCollectionRequests(["c1", "c2"]), {
			wrapper: wrapper(newClient()),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.requestsByCollection.get("c1")?.map((r) => r.id)).toEqual([
			"older",
			"newer",
			"late",
		]);
		// An empty collection is present with an empty list, not missing: callers
		// distinguish "no requests" from "not asked for".
		expect(result.current.requestsByCollection.get("c2")).toEqual([]);
	});
});

/**
 * The column audit reads what each request sends, which a summary does not
 * carry (#2546): its lists are the whole rows, fetched for it alone.
 */
describe("useFullCollectionRequests", () => {
	const full = (id: string, collectionId: string) =>
		({
			...req(id, collectionId),
			headers: [{ key: "X-Plan", value: "{{data.plan}}", enabled: true }],
		}) as Request;

	beforeEach(() => {
		listRequests.mockImplementation(({ collectionId }: { collectionId: string }) =>
			Promise.resolve(collectionId === "c1" ? [full("r1", "c1")] : [])
		);
	});

	it("fetches each collection's whole rows, not its summaries", async () => {
		const { result } = renderHook(() => useFullCollectionRequests(["c1", "c2"]), {
			wrapper: wrapper(newClient()),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(listRequests.mock.calls).toEqual([
			[{ collectionId: "c1" }],
			[{ collectionId: "c2" }],
		]);
		expect(listRequestSummaries).not.toHaveBeenCalled();
		expect(result.current.requestsByCollection.get("c1")?.[0].headers).toEqual([
			{ key: "X-Plan", value: "{{data.plan}}", enabled: true },
		]);
		expect(result.current.requestsByCollection.get("c2")).toEqual([]);
	});

	it("refetches when that collection's tree list is invalidated", async () => {
		// Every write that can change a request invalidates its owner's
		// `listByCollection`; the whole rows sit under that key so they go stale
		// with it rather than needing an invalidation of their own.
		const client = newClient();
		const { result } = renderHook(() => useFullCollectionRequests(["c1"]), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		listRequests.mockClear();

		await act(async () => {
			await client.invalidateQueries({
				queryKey: queryKeys.requests.listByCollection("c1"),
			});
		});

		expect(listRequests.mock.calls).toEqual([[{ collectionId: "c1" }]]);
	});

	it("counts a request created in that collection, a Duplicate's copy included", async () => {
		const client = newClient();
		const lists = renderHook(() => useFullCollectionRequests(["c1"]), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(lists.result.current.isLoading).toBe(false));
		createRequest.mockResolvedValue(full("r2", "c1"));
		const create = renderHook(() => useCreateRequestMutation(), { wrapper: wrapper(client) });

		await act(async () => {
			await create.result.current.mutateAsync({
				collectionId: "c1",
				name: "r2",
				method: "GET",
				url: "",
			});
		});

		await waitFor(() =>
			expect(lists.result.current.requestsByCollection.get("c1")?.map((r) => r.id)).toEqual([
				"r1",
				"r2",
			])
		);

		// A collection whose whole rows nothing holds gets no partial list made
		// up for it: an entry would be served as if it were the whole answer.
		createRequest.mockResolvedValue(full("r3", "c3"));
		await act(async () => {
			await create.result.current.mutateAsync({
				collectionId: "c3",
				name: "r3",
				method: "GET",
				url: "",
			});
		});
		expect(client.getQueryData(queryKeys.requests.fullListByCollection("c3"))).toBeUndefined();
	});
});
