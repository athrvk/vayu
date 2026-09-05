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
 * What a restore and a purge invalidate.
 *
 * The view-level tests replace `@/queries` wholesale - that is what makes them
 * tests of the view - so nothing there exercises this file, and emptying both
 * `onSuccess` bodies left the whole suite green while a restored collection
 * never reappeared in the tree. This file is the missing half: the real hooks,
 * a real QueryClient, and only `apiService` stubbed.
 *
 * The asymmetry is the thing under test. A restore crosses back into the live
 * caches, so it has to invalidate them; a purge destroys rows that every live
 * read already filtered out, so invalidating the tree for it would refetch it
 * to produce the same answer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useRestoreTrashMutation, usePurgeTrashMutation, useTrashQuery } from "./trash";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";

vi.mock("@/services/api", () => ({
	apiService: {
		listTrash: vi.fn(),
		restoreTrashEntry: vi.fn(),
		purgeTrashEntry: vi.fn(),
	},
}));

let client: QueryClient;
let invalidated: string[][];

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client }, children);
}

/** The key prefixes handed to `invalidateQueries`, as plain arrays. */
function invalidatedKeys() {
	return invalidated.map((k) => k.join("/"));
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	invalidated = [];
	const real = client.invalidateQueries.bind(client);
	vi.spyOn(client, "invalidateQueries").mockImplementation((filters) => {
		invalidated.push((filters?.queryKey ?? []) as string[]);
		return real(filters);
	});
	vi.mocked(apiService.restoreTrashEntry).mockResolvedValue({
		id: "c1",
		kind: "collection",
		name: "Billing",
		deletedAt: 1,
		collections: 0,
		requests: 1,
		restored: true,
		reparentedToRoot: false,
	});
	vi.mocked(apiService.purgeTrashEntry).mockResolvedValue({
		id: "c1",
		kind: "collection",
		name: "Billing",
		deletedAt: 1,
		collections: 0,
		requests: 1,
		purged: true,
	});
	vi.mocked(apiService.listTrash).mockResolvedValue({ items: [], total: 0 });
});

describe("useTrashQuery", () => {
	it("reads GET /trash under the trash list key", async () => {
		const { result } = renderHook(() => useTrashQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(apiService.listTrash).toHaveBeenCalled();
		expect(client.getQueryData(queryKeys.trash.list())).toEqual({ items: [], total: 0 });
	});
});

describe("useRestoreTrashMutation", () => {
	it("restores through the API and puts the rows back into the live caches", async () => {
		const { result } = renderHook(() => useRestoreTrashMutation(), { wrapper });

		await result.current.mutateAsync("c1");

		expect(apiService.restoreTrashEntry).toHaveBeenCalledWith("c1");
		// The tree reads collections and requests; without these two a restored
		// collection stays invisible until something else happens to refetch.
		expect(invalidatedKeys()).toContain(queryKeys.collections.all.join("/"));
		expect(invalidatedKeys()).toContain(queryKeys.requests.all.join("/"));
		// The warm-cache pass has never seen the restored collection.
		expect(invalidatedKeys()).toContain(queryKeys.prefetch.allRequests().join("/"));
		// And the row has left the trash it was listed in.
		expect(invalidatedKeys()).toContain(queryKeys.trash.all.join("/"));
	});

	it("refetches the list when the restore fails, so a phantom row cannot survive", async () => {
		// The row this acted on is one the list said existed, so the likeliest
		// failure is that it no longer does - an agent purged or restored it since
		// the drawer's last read (issue #1438). Leaving the list alone keeps a row
		// on screen that fails the same way on every further click.
		vi.mocked(apiService.restoreTrashEntry).mockRejectedValue(new Error("Request not found"));
		const { result } = renderHook(() => useRestoreTrashMutation(), { wrapper });

		await expect(result.current.mutateAsync("gone")).rejects.toThrow("Request not found");

		expect(invalidatedKeys()).toContain(queryKeys.trash.all.join("/"));
		// Only the list: nothing crossed back into the live caches, because nothing
		// was restored.
		expect(invalidatedKeys()).not.toContain(queryKeys.collections.all.join("/"));
		expect(invalidatedKeys()).not.toContain(queryKeys.requests.all.join("/"));
	});
});

describe("usePurgeTrashMutation", () => {
	it("purges through the API", async () => {
		const { result } = renderHook(() => usePurgeTrashMutation(), { wrapper });

		await result.current.mutateAsync("c1");

		expect(apiService.purgeTrashEntry).toHaveBeenCalledWith("c1");
		expect(invalidatedKeys()).toContain(queryKeys.trash.all.join("/"));
	});

	it("leaves the live caches alone - they never served these rows", async () => {
		const { result } = renderHook(() => usePurgeTrashMutation(), { wrapper });

		await result.current.mutateAsync("c1");

		expect(invalidatedKeys()).not.toContain(queryKeys.collections.all.join("/"));
		expect(invalidatedKeys()).not.toContain(queryKeys.requests.all.join("/"));
	});

	it("refetches the list when the purge fails, the same way a failed restore does", async () => {
		// A purge that fails on a row the list still shows is the same phantom the
		// restore path has, and a rule that held on one of the two buttons a trash
		// row carries would be the harder one to keep true.
		vi.mocked(apiService.purgeTrashEntry).mockRejectedValue(new Error("Request not found"));
		const { result } = renderHook(() => usePurgeTrashMutation(), { wrapper });

		await expect(result.current.mutateAsync("gone")).rejects.toThrow("Request not found");

		expect(invalidatedKeys()).toContain(queryKeys.trash.all.join("/"));
	});
});
