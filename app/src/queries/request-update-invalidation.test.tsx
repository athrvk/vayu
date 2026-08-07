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
 * Updating one request invalidates the lists that can have changed, and no
 * others (issue #360).
 *
 * `useUpdateRequestMutation` used to invalidate `requests.lists()` - *every*
 * collection's list - on any single-request write, so renaming one request
 * refetched the whole tree. Reorder is a run of sibling PUTs, which turned that
 * into one full-tree refetch per row.
 *
 * "Invalidated" is the assertion, not "absent": invalidation is what sends the
 * next read back to the engine, and `getQueryData` looks identical either way
 * (same shape as `collection-cascade-delete.test.tsx`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUpdateRequestMutation } from "./collections";
import { queryKeys } from "./keys";
import type { Request } from "@/types";

const updateRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		updateRequest: (...a: unknown[]) => updateRequest(...a),
	},
}));

const req = (id: string, collectionId: string): Request =>
	({ id, collectionId, name: id, order: 0 }) as unknown as Request;

function makeClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** Three collections with a cached list each, plus the request's detail entry. */
function seed(client: QueryClient) {
	for (const id of ["col_a", "col_b", "col_c"]) {
		client.setQueryData(queryKeys.requests.listByCollection(id), []);
	}
	client.setQueryData(queryKeys.requests.detail("req_1"), req("req_1", "col_a"));
}

beforeEach(() => vi.clearAllMocks());

describe("useUpdateRequestMutation invalidates only the affected lists", () => {
	it("touches one list when a request is renamed in place", async () => {
		updateRequest.mockResolvedValue({ ...req("req_1", "col_a"), name: "Renamed" });
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useUpdateRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "req_1", name: "Renamed" });

		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_a"))?.isInvalidated
		).toBe(true);
		// The two uninvolved collections. Reverting to `invalidateQueries(lists())`
		// turns both of these true.
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_b"))?.isInvalidated
		).toBe(false);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_c"))?.isInvalidated
		).toBe(false);
	});

	it("touches both sides of a cross-collection move", async () => {
		updateRequest.mockResolvedValue(req("req_1", "col_b"));
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useUpdateRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "req_1", collectionId: "col_b" });

		// Destination, from the response; source, from the detail cache's
		// pre-update row - the only place the old owner is still knowable.
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_b"))?.isInvalidated
		).toBe(true);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_a"))?.isInvalidated
		).toBe(true);
		expect(
			client.getQueryState(queryKeys.requests.listByCollection("col_c"))?.isInvalidated
		).toBe(false);
	});

	it("writes the updated row into the detail cache", async () => {
		const updated = { ...req("req_1", "col_a"), name: "Renamed" };
		updateRequest.mockResolvedValue(updated);
		const client = makeClient();
		seed(client);

		const { result } = renderHook(() => useUpdateRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync({ id: "req_1", name: "Renamed" });

		expect(client.getQueryData(queryKeys.requests.detail("req_1"))).toEqual(updated);
	});
});
