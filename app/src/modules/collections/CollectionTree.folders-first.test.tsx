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
 * A folder's subfolders and its requests are two separately ordered blocks, and
 * the tree renders every subfolder above every request (issue #364's fourth
 * tracking criterion, #426).
 *
 * This is what keeps a drag honest. `reorder-math.ts` plans against one block at
 * a time and renumbers it dense `0..n-1`, so after a reorder a request and a
 * subfolder in the same folder hold the *same* `order` values - the column
 * cannot say which of the two comes first, and only the render decides. Sorting
 * the two blocks together on `order` is therefore not a near-miss but a
 * different tree: here the request holds a lower `order` than the subfolder, so
 * a merged sort would lift it above the folder, and a drop planned against the
 * block the user saw would land somewhere else.
 *
 * The engine cannot express this - collections and requests are different
 * tables, so `tree-order-conformance.json` pins one block at a time and this
 * pins the relationship between them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

// The post-drag collision: inside "acme", the request sits at order 0 and the
// subfolder at order 1. Both blocks are dense, which is exactly what a reorder
// leaves behind - the numbers agree only because they count different things.
const collections = [
	{ id: "acme", name: "Acme", order: 0 },
	{ id: "billing", name: "Billing", parentId: "acme", order: 1 },
];
const requests = new Map([
	["acme", [{ id: "r-ping", collectionId: "acme", name: "Ping", method: "GET", order: 0 }]],
]);

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: requests }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["acme"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("subfolders and requests are separate blocks, folders first", () => {
	it("renders a subfolder above a request that holds a lower order", () => {
		renderTree();

		const folder = document.querySelector<HTMLElement>('[data-collection-id="billing"]')!;
		const request = document.querySelector<HTMLElement>('[data-request-id="r-ping"]')!;
		expect(folder).not.toBeNull();
		expect(request).not.toBeNull();

		// DOCUMENT_POSITION_FOLLOWING: the request comes after the folder in the
		// rendered tree, despite ordering ahead of it on the column alone.
		expect(
			folder.compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("keeps both rows in the same group, so the split is render-order only", () => {
		renderTree();

		// If the blocks were merged and sorted, or split into two groups, the
		// numbering below would not be a single run of two.
		const folder = document.querySelector<HTMLElement>('[data-collection-id="billing"]')!;
		const request = document.querySelector<HTMLElement>('[data-request-id="r-ping"]')!;
		expect(folder).toHaveAttribute("aria-posinset", "1");
		expect(request).toHaveAttribute("aria-posinset", "2");
		expect(folder).toHaveAttribute("aria-setsize", "2");
		expect(request).toHaveAttribute("aria-setsize", "2");
	});
});
