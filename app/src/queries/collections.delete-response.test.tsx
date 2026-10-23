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
 * Deleting a request has to take its response with it.
 *
 * `response-store` is keyed by request id and nothing evicted from it: both of
 * its clearing actions had zero callers, so a session accumulated every
 * response it had ever rendered - body plus raw copy - including for requests
 * that had since been deleted.
 *
 * The tab seam (`closeTabsForEntities`) covers the tree's delete flows, and
 * this covers the delete itself: it is the mutation, not the tab, that makes
 * the response unreachable, and a caller that deletes without touching tabs
 * would otherwise leak the entry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDeleteCollectionMutation, useDeleteRequestMutation } from "./collections";
import { installFileBindingMirror } from "./file-bindings";
import { queryKeys } from "./keys";
import { useResponseStore } from "@/stores/response-store";
import { useDataFileStore } from "@/stores/data-file-store";
import { useSpecFileStore } from "@/stores/spec-file-store";
import type { Collection } from "@/types";

const deleteRequest = vi.fn();
const deleteCollection = vi.fn();
const updateCollection = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		deleteRequest: (...a: unknown[]) => deleteRequest(...a),
		deleteCollection: (...a: unknown[]) => deleteCollection(...a),
		updateCollection: (...a: unknown[]) => updateCollection(...a),
	},
}));

const wrapper = (client: QueryClient) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};

const storeResponse = (requestId: string) =>
	useResponseStore.getState().setResponse(requestId, {
		status: 200,
		statusText: "OK",
		headers: {},
		body: "{}",
		bodyType: "json",
		size: 2,
		time: 1,
	});

beforeEach(() => {
	deleteRequest.mockReset();
	deleteCollection.mockReset();
	useResponseStore.getState().clearAll();
	useDataFileStore.setState({ locations: {} });
	useSpecFileStore.setState({ locations: {} });
});

describe("useDeleteRequestMutation", () => {
	it("drops the deleted request's stored response", async () => {
		deleteRequest.mockResolvedValue(undefined);
		storeResponse("req_1");
		storeResponse("req_2");

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useDeleteRequestMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("req_1");

		await waitFor(() => {
			expect(useResponseStore.getState().getResponse("req_1")).toBeNull();
		});
		expect(useResponseStore.getState().getResponse("req_2")).not.toBeNull();
	});

	it("keeps the response when the delete fails", async () => {
		// onSuccess only. A failed delete leaves the request alive, and its
		// response is still the one the user is looking at.
		deleteRequest.mockRejectedValue(new Error("database is locked"));
		storeResponse("req_1");

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useDeleteRequestMutation(), {
			wrapper: wrapper(client),
		});
		await expect(result.current.mutateAsync("req_1")).rejects.toThrow("database is locked");

		expect(useResponseStore.getState().getResponse("req_1")).not.toBeNull();
	});
});

/*
 * A collection's spec-file and data-file bindings are columns of its row
 * (#2765): a delete moves the row to the trash with them on it, so the client
 * clears nothing - the stores follow the list, and a restore brings the
 * bindings back with the row. Mutation check: clear the bindings from the
 * delete's `onSuccess` with a `specFile: null, dataFile: null` update and this
 * fails - a restore would bring the row back unbound.
 */
describe("useDeleteCollectionMutation", () => {
	const bound = (id: string): Collection =>
		({
			id,
			name: id,
			order: 0,
			specFile: { path: `/s/${id}.yaml`, fileName: `${id}.yaml` },
			dataFile: { path: `/d/${id}.csv`, fileName: `${id}.csv` },
		}) as Collection;

	it("writes no binding: the row leaves the view with its bindings on it", async () => {
		deleteCollection.mockResolvedValue(undefined);
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const uninstall = installFileBindingMirror(client);
		client.setQueryData(queryKeys.collections.list(), [bound("col_1"), bound("col_2")]);

		const { result } = renderHook(() => useDeleteCollectionMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("col_1");

		expect(updateCollection).not.toHaveBeenCalled();
		expect(Object.keys(useDataFileStore.getState().locations)).toEqual(["col_2"]);
		expect(Object.keys(useSpecFileStore.getState().locations)).toEqual(["col_2"]);

		// The restore's refetch answers the row with its bindings, and they are
		// back - nothing on this side had to remember them.
		client.setQueryData(queryKeys.collections.list(), [bound("col_1"), bound("col_2")]);
		expect(useDataFileStore.getState().locations.col_1).toEqual(bound("col_1").dataFile);
		expect(useSpecFileStore.getState().locations.col_1).toEqual(bound("col_1").specFile);
		uninstall();
	});
});
