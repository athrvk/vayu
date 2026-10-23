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
 * A request detail's `runsPreRequestScript` stays true to the scripts it is
 * derived from (#2741).
 *
 * The engine derives the flag from the request's own scripts and those of its
 * folder and collection, and a detail is `staleTime: Infinity`, so a write that
 * reaches a request only through its ancestors has to invalidate the detail
 * itself. "Invalidated" is the assertion, not "absent": it is what sends the
 * next read back to the engine.
 *
 * Mutation check, in `queries/collections.ts`: drop the `setQueryData` in
 * `useUpdateRequestMutation` and the save case fails; make the collection
 * patch's guard `true` and "only the name changes" fails, `false` and the two
 * script/parent cases fail; make the drop's guard never fire and the two
 * new-owner cases fail, always fire and "states no new owner" fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	useReorderMutation,
	useUpdateCollectionMutation,
	useUpdateRequestMutation,
} from "./collections";
import { queryKeys } from "./keys";
import type { Request } from "@/types";

const updateRequest = vi.fn();
const updateCollection = vi.fn();
const reorder = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		updateRequest: (...a: unknown[]) => updateRequest(...a),
		updateCollection: (...a: unknown[]) => updateCollection(...a),
		reorder: (...a: unknown[]) => reorder(...a),
	},
}));

const detail = (id: string, runsPreRequestScript: boolean): Request =>
	({ id, collectionId: "col_a", name: id, order: 0, runsPreRequestScript }) as unknown as Request;

function makeClient() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(queryKeys.requests.detail("req_1"), detail("req_1", false));
	client.setQueryData(queryKeys.requests.detail("req_2"), detail("req_2", false));
	return client;
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const detailInvalidated = (client: QueryClient, id: string) =>
	client.getQueryState(queryKeys.requests.detail(id))?.isInvalidated;

beforeEach(() => vi.clearAllMocks());

describe("saving a request", () => {
	it("writes the response's flag into the detail the builder reads", async () => {
		updateRequest.mockResolvedValue(detail("req_1", true));
		const client = makeClient();

		const { result } = renderHook(() => useUpdateRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "req_1", elements: [] });

		expect(
			client.getQueryData<Request>(queryKeys.requests.detail("req_1"))?.runsPreRequestScript
		).toBe(true);
	});
});

describe("editing a collection", () => {
	async function update(patch: { elements?: []; parentId?: string | null; name?: string }) {
		updateCollection.mockResolvedValue({ id: "col_a", name: "col_a" });
		const client = makeClient();
		const { result } = renderHook(() => useUpdateCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "col_a", ...patch });
		return client;
	}

	it("invalidates every request detail when its scripts are written", async () => {
		const client = await update({ elements: [] });
		expect(detailInvalidated(client, "req_1")).toBe(true);
		expect(detailInvalidated(client, "req_2")).toBe(true);
	});

	it("invalidates them when the collection moves under another parent", async () => {
		expect(detailInvalidated(await update({ parentId: "col_b" }), "req_1")).toBe(true);
		expect(detailInvalidated(await update({ parentId: null }), "req_1")).toBe(true);
	});

	it("leaves them alone when only the name changes", async () => {
		const client = await update({ name: "Renamed" });
		expect(detailInvalidated(client, "req_1")).toBe(false);
	});
});

describe("a drop", () => {
	async function drop(moves: Parameters<typeof reorder>[0]["moves"]) {
		reorder.mockResolvedValue({ collections: [], requests: [] });
		const client = makeClient();
		const { result } = renderHook(() => useReorderMutation(), { wrapper: wrapper(client) });
		await result.current.mutateAsync({ moves, normalize: [] });
		return client;
	}

	it("invalidates the details when a request changes collection", async () => {
		const client = await drop([
			{ type: "request", id: "req_1", order: 0, collectionId: "col_b" },
		]);
		expect(detailInvalidated(client, "req_2")).toBe(true);
	});

	it("invalidates the details when a collection changes parent", async () => {
		const client = await drop([
			{ type: "collection", id: "col_a", order: 0, parentId: "col_b" },
		]);
		expect(detailInvalidated(client, "req_1")).toBe(true);
	});

	it("leaves them alone for a reorder that states no new owner", async () => {
		const client = await drop([
			{ type: "request", id: "req_1", order: 1 },
			{ type: "collection", id: "col_a", order: 2 },
		]);
		expect(detailInvalidated(client, "req_1")).toBe(false);
	});
});
