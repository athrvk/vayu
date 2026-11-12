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
 * Which of the tree's tab opens count as a pick from the drawer (#3507).
 *
 * Choosing a row tells the drawer, which an overlay answers by leaving. A
 * duplicate also opens a tab, but nobody chose that row to read it, so the
 * drawer stays put.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useTreeCrud } from "./useTreeCrud";
import { DrawerItemOpenedProvider } from "@/components/layout/drawer-item-opened";
import { useTabsStore } from "@/stores";
import type { Collection, Request, RequestSummary } from "@/types";

const getRequest = vi.fn<(id: string) => Promise<Request>>();

vi.mock("@/services/api", () => ({
	apiService: { listRequestExamples: async () => [], createRequestExample: vi.fn() },
}));

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({
		mutateAsync: async () => ({ id: "r-copy", collectionId: "c-1" }),
		isPending: false,
	}),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	requestDetailOptions: (id: string) => ({
		queryKey: ["requests", "detail", id],
		queryFn: () => getRequest(id),
		retry: false,
		staleTime: Infinity,
	}),
}));

const collection = { id: "c-1", name: "Acme", order: 0 } as Collection;
const row = {
	id: "r-1",
	collectionId: "c-1",
	name: "Get pet",
	method: "GET",
	url: "https://api.example.com/pets",
	order: 0,
} as RequestSummary;
const requestsByCollection = new Map([["c-1", [row]]]);

const onItemOpened = vi.fn();

function renderCrud() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<DrawerItemOpenedProvider value={onItemOpened}>{children}</DrawerItemOpenedProvider>
		</QueryClientProvider>
	);
	return renderHook(
		() =>
			useTreeCrud({
				collections: [collection],
				requestsByCollection,
				getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
				revealEntity: vi.fn(),
			}),
		{ wrapper }
	);
}

beforeEach(() => {
	onItemOpened.mockClear();
	getRequest.mockReset();
	getRequest.mockResolvedValue({ ...row, headers: [], params: [] } as unknown as Request);
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("the collection tree's opens", () => {
	it("tells the drawer after opening a request", () => {
		const { result } = renderCrud();
		act(() => result.current.handlers.onRequestClick("c-1", "r-1"));
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r-1"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});

	it("tells the drawer after opening a collection", () => {
		const { result } = renderCrud();
		act(() => result.current.handlers.onCollectionClick(collection));
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["c-1"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});

	// A created request is a pick from the drawer as much as a clicked row: the
	// row menu's Add request and the toolbar's New request (`useNewRequest`) agree.
	it("tells the drawer after the row menu's Add request opens the new request", async () => {
		const { result } = renderCrud();
		const addRequest = result.current.handlers
			.getCollectionActions(collection)
			.find((a) => "label" in a && a.label === "Add request");
		await act(async () => {
			await (addRequest as { onSelect: () => Promise<void> | void }).onSelect();
		});
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r-copy"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});

	it("does not for the copy a duplicate opens", async () => {
		const { result } = renderCrud();
		await act(async () => {
			await result.current.handlers.onDuplicateRequest(row);
		});
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r-copy"]);
		expect(onItemOpened).not.toHaveBeenCalled();
	});
});
