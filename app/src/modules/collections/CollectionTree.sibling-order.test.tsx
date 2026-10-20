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
 * A folder's sub-folders and its requests are one list, sorted by one `order`
 * (#2535), and the tree renders that list as it sorts - not every sub-folder
 * above every request, the two-block rule of #426.
 *
 * A Postman collection runs its items in document order, so an import that
 * puts a "Get token" request ahead of the feature folders has to show it there:
 * the recursive run walks the same merged list
 * (`CollectionTree.run-order.conformance.test.tsx`), and a tree that lifted the
 * folders above it would be showing an order nothing executes. A tie on
 * `order` across kinds is the one place a kind still decides, and it ranks the
 * folder first - the display every pre-#2535 workspace, whose two kinds were
 * each numbered from 0, already had.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

// Inside "acme": a request at 0, a sub-folder at 1, and a second request tied
// with that sub-folder at 1. The request at 0 renders above the folder; the tie
// ranks the folder first even though the request is older.
const collections = [
	{ id: "acme", name: "Acme", order: 0, createdAt: "2026-01-02T00:00:00.000Z" },
	{
		id: "billing",
		name: "Billing",
		parentId: "acme",
		order: 1,
		createdAt: "2026-01-02T00:00:00.000Z",
	},
];
const requests = new Map([
	[
		"acme",
		[
			{ id: "r-ping", collectionId: "acme", name: "Ping", method: "GET", order: 0 },
			{
				id: "r-tied",
				collectionId: "acme",
				name: "Tied",
				method: "GET",
				order: 1,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
	],
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
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

/**
 * Acme's children, top to bottom. The tree is one flat list (#2543) and acme is
 * the only folder expanded, so its children are exactly the level-2 rows.
 */
function acmeChildren(): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"][aria-level="2"]')
	);
}

describe("a folder's sub-folders and requests are one list", () => {
	it("renders a request with a lower order above a sub-folder", () => {
		renderTree();

		const ids = acmeChildren().map(
			(row) => row.getAttribute("data-request-id") ?? row.getAttribute("data-collection-id")
		);
		expect(ids).toEqual(["r-ping", "billing", "r-tied"]);
	});

	it("ranks the folder first on an order tie, ahead of an older request", () => {
		renderTree();

		const folder = document.querySelector<HTMLElement>('[data-collection-id="billing"]')!;
		const tied = document.querySelector<HTMLElement>('[data-request-id="r-tied"]')!;
		// DOCUMENT_POSITION_FOLLOWING: the request comes after the folder, though
		// its createdAt alone would put it first.
		expect(
			folder.compareDocumentPosition(tied) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("numbers the treeitems over the merged list", () => {
		renderTree();

		expect(
			acmeChildren().map((row) => [
				row.getAttribute("aria-posinset"),
				row.getAttribute("aria-setsize"),
			])
		).toEqual([
			["1", "3"],
			["2", "3"],
			["3", "3"],
		]);
	});
});
