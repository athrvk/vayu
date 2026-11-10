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
 * A change feed event landing while a drop is in flight must not put the tree
 * back in its pre-drop order (issue #3420). `useReorderMutation` cancels the
 * in-flight list reads before it draws the drop, because a read that lands
 * after the draw overwrites it; an invalidation the feed fires mid-flight would
 * start exactly such a read. Driven through the real mutation and the real list
 * query, with the engine's two answers stubbed: the pre-drop rows until the
 * reorder commits, the dropped order after.
 */

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useReorderMutation, useRequestsQuery } from "@/queries/collections";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import type { ReorderResponse, Request, RequestSummary } from "@/types";
import {
	CHANGE_FEED_COALESCE_MS,
	FeedInvalidationBatch,
	invalidationsForChange,
} from "./change-feed-invalidation";

function row(id: string, order: number): RequestSummary {
	return {
		id,
		collectionId: "col_1",
		name: id,
		method: "GET",
		url: `https://api.test/${id}`,
		order,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

let serverRows: RequestSummary[];
let listCalls: () => number;
let commitReorder: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	serverRows = [row("a", 0), row("b", 1)];
	const list = vi
		.spyOn(apiService, "listRequestSummaries")
		.mockImplementation(async () => serverRows.map((r) => ({ ...r })));
	listCalls = () => list.mock.calls.length;
	vi.spyOn(apiService, "reorder").mockImplementation(
		() =>
			new Promise<ReorderResponse>((resolve) => {
				commitReorder = () => {
					serverRows = [row("b", 0), row("a", 1)];
					resolve({ collections: [], requests: serverRows as Request[] });
				};
			})
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function setup() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const view = renderHook(
		() => ({ list: useRequestsQuery("col_1"), reorder: useReorderMutation() }),
		{ wrapper }
	);
	const shown = () =>
		queryClient
			.getQueryData<RequestSummary[]>(queryKeys.requests.listByCollection("col_1"))
			?.map((r) => r.id);
	return { queryClient, view, shown };
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("a feed event during a drop", () => {
	it("waits for the reorder to settle instead of refetching under its draw", async () => {
		const { queryClient, view, shown } = setup();
		await settle();
		expect(shown()).toEqual(["a", "b"]);
		expect(listCalls()).toBe(1);

		act(() =>
			view.result.current.reorder.mutate({
				moves: [
					{ type: "request", id: "b", order: 0 },
					{ type: "request", id: "a", order: 1 },
				],
				normalize: [],
			})
		);
		await settle();
		expect(shown()).toEqual(["b", "a"]);

		// Another client's write to a row in the same list, reported before the
		// reorder has committed: a read now would answer the pre-drop order.
		const batch = new FeedInvalidationBatch(queryClient);
		batch.add(
			invalidationsForChange(queryClient, {
				kind: "request",
				id: "a",
				op: "update",
				collectionId: "col_1",
			})!
		);
		await act(() => vi.advanceTimersByTimeAsync(CHANGE_FEED_COALESCE_MS * 5));

		expect(listCalls()).toBe(1);
		expect(shown()).toEqual(["b", "a"]);

		// Once the drop lands, the held invalidation reads what it committed.
		commitReorder();
		await settle();
		await settle();
		expect(listCalls()).toBeGreaterThan(1);
		expect(shown()).toEqual(["b", "a"]);
	});
});
