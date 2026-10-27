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
import { useRequestExamplesQuery } from "./request-examples";
import { queryKeys } from "./keys";
import { apiService } from "@/services/api";
import { useDataFileStore } from "@/stores/data-file-store";
import { useSpecFileStore } from "@/stores/spec-file-store";

vi.mock("@/services/api", () => ({
	apiService: {
		listTrash: vi.fn(),
		restoreTrashEntry: vi.fn(),
		purgeTrashEntry: vi.fn(),
		updateCollection: vi.fn(),
		listRequestExamples: vi.fn(),
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
	useDataFileStore.setState({ locations: {} });
	useSpecFileStore.setState({ locations: {} });
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

	it("invalidates exactly the trash, the tree, the environments, every composition and the certificate registry", async () => {
		// The whole list, so a key added or dropped here is a decision a test
		// names. `environments.all` covers the list and the details the
		// Variables view reads, and `compose.all` the compositions a restored
		// environment's variables feed (#2970); `clientCertificates.all` is the
		// registry card a restored certificate must reappear in (#2973).
		// Mutation check: drop the environments or the certificates line from the
		// restore's `onSuccess` and this fails.
		const { result } = renderHook(() => useRestoreTrashMutation(), { wrapper });

		await result.current.mutateAsync("e1");

		expect([...invalidatedKeys()].sort()).toEqual(
			[
				queryKeys.trash.all,
				queryKeys.collections.all,
				queryKeys.prefetch.allRequests(),
				queryKeys.requests.all,
				queryKeys.environments.all,
				queryKeys.compose.all,
				queryKeys.clientCertificates.all,
			]
				.map((k) => k.join("/"))
				.sort()
		);
	});

	it("refetches an open examples list, so a restored example reappears in its request", async () => {
		// The Examples panel's list is keyed under `requests.detail(<id>)`, which
		// `requests.all` covers by prefix (#2971). Mutation check: invalidate
		// anything narrower than `requests.all` in the restore and this fails.
		vi.mocked(apiService.listRequestExamples).mockResolvedValue([]);
		const examples = renderHook(() => useRequestExamplesQuery("req_1"), { wrapper });
		await waitFor(() => expect(examples.result.current.isSuccess).toBe(true));
		expect(apiService.listRequestExamples).toHaveBeenCalledTimes(1);

		vi.mocked(apiService.restoreTrashEntry).mockResolvedValue({
			id: "exa_1",
			kind: "example",
			name: "Happy path",
			deletedAt: 1,
			collections: 0,
			requests: 0,
			restored: true,
			reparentedToRoot: false,
		});
		const { result } = renderHook(() => useRestoreTrashMutation(), { wrapper });
		await result.current.mutateAsync("exa_1");

		await waitFor(() => expect(apiService.listRequestExamples).toHaveBeenCalledTimes(2));
	});

	it("refetches the list when the restore fails, so a phantom row cannot survive", async () => {
		// The row this acted on is one the list said existed, so the likeliest
		// failure is that it no longer does - an agent purged or restored it since
		// the drawer's last read (issue #1438). Leaving the list alone keeps a row
		// on screen that fails the same way on every further click.
		vi.mocked(apiService.restoreTrashEntry).mockRejectedValue(new Error("Request not found"));
		const { result } = renderHook(() => useRestoreTrashMutation(), { wrapper });

		await expect(result.current.mutateAsync("gone")).rejects.toThrow("Request not found");

		// Only the list: nothing crossed back into the live caches, because nothing
		// was restored.
		expect(invalidatedKeys()).toEqual([queryKeys.trash.all.join("/")]);
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

		// The trash list and nothing else - an environment purge included: the
		// Variables view stopped listing it when it was deleted.
		expect(invalidatedKeys()).toEqual([queryKeys.trash.all.join("/")]);
	});

	/*
	 * The purged row's spec-file and data-file bindings are its own columns
	 * (#2765) and go with it, engine-side. A trashed row was already out of the
	 * list the stores mirror, so there is nothing here to clear either - and a
	 * write naming a purged id would be a 404. Mutation check: clear either
	 * binding from the purge's `onSuccess` and this fails.
	 */
	it("writes no binding and touches neither store: the purge takes them with the row", async () => {
		useDataFileStore.setState({ locations: { c2: { path: "/d/c2.csv", fileName: "c2.csv" } } });
		useSpecFileStore.setState({
			locations: { c2: { path: "/s/c2.yaml", fileName: "c2.yaml" } },
		});
		const dataFiles = useDataFileStore.getState().locations;
		const specFiles = useSpecFileStore.getState().locations;
		const { result } = renderHook(() => usePurgeTrashMutation(), { wrapper });

		await result.current.mutateAsync("c1");

		expect(apiService.updateCollection).not.toHaveBeenCalled();
		expect(useDataFileStore.getState().locations).toBe(dataFiles);
		expect(useSpecFileStore.getState().locations).toBe(specFiles);
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
