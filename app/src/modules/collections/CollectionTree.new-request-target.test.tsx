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
 * The tree's "+" used to carry its own copy of the new-request target rule and
 * fell back to the topmost root (#1911), so with several collections it filled
 * whichever sorted first while every other entry point used the collection the
 * user was last in, or asked. It now goes through `useNewRequest`; what stays
 * its own is the override: a collection's open tab names the collection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const createRequest = vi.fn();
const createCollection = vi.fn();

const roots = [
	{ id: "alpha", name: "Alpha", order: 0 },
	{ id: "beta", name: "Beta", order: 1 },
	{ id: "gamma", name: "Gamma", order: 2 },
];
const nested = { id: "nested", name: "Nested", order: 0, parentId: "gamma" };
const collections = [...roots, nested];

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
	useCreateCollectionMutation: () => ({ mutateAsync: createCollection, isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const addRequestButton = () => screen.getByRole("button", { name: "Add request" });

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r-new", collectionId: "nested" });
	createCollection.mockReset();
	useSessionStore.setState({ lastCollectionId: null });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
	useCollectionsStore.setState({ expandedCollectionIds: new Set() });
});

describe("the tree's Add request button", () => {
	it("lands in the collection last worked in when a request tab is active", async () => {
		useSessionStore.setState({ lastCollectionId: "nested" });
		useTabsStore.getState().openTab({ type: "request", entityId: "r1" });
		renderTree();

		fireEvent.click(addRequestButton());

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toMatchObject({ collectionId: "nested" });
	});

	it("asks which collection when there is no memory and several roots", async () => {
		renderTree();

		fireEvent.click(addRequestButton());

		expect(await screen.findByText("Add request to")).toBeInTheDocument();
		expect(createRequest).not.toHaveBeenCalled();
	});

	it("lets an open collection tab name the collection over the remembered one", async () => {
		useSessionStore.setState({ lastCollectionId: "nested" });
		useTabsStore.getState().openTab({ type: "collection", entityId: "beta" });
		renderTree();

		fireEvent.click(addRequestButton());

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toMatchObject({ collectionId: "beta" });
	});

	it("falls back to the rule when the open collection tab outlived its collection", async () => {
		useSessionStore.setState({ lastCollectionId: "nested" });
		useTabsStore.getState().openTab({ type: "collection", entityId: "deleted" });
		renderTree();

		fireEvent.click(addRequestButton());

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toMatchObject({ collectionId: "nested" });
	});

	it("names the destination in the tooltip only when it is not a guess", async () => {
		useSessionStore.setState({ lastCollectionId: "nested" });
		const { unmount } = renderTree();
		fireEvent.focus(addRequestButton());
		expect((await screen.findAllByText("Add request in Nested")).length).toBeGreaterThan(0);
		unmount();

		useSessionStore.setState({ lastCollectionId: null });
		renderTree();
		fireEvent.focus(addRequestButton());
		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip).toHaveTextContent(/^Add request$/);
	});
});
