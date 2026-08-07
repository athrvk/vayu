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
 * A collection whose parent is not among the loaded collections used to render
 * nowhere at all: it failed the roots filter (`!c.parentId`) and no parent row
 * existed to list it as a child. That is exactly the state a bad or half-applied
 * reparent leaves behind, and the symptom was a collection - with its requests -
 * silently vanishing from the sidebar while still existing in the database.
 *
 * Degrading visibly beats degrading invisibly: the row appears at the top level,
 * where it can be opened, renamed or deleted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

// `stray` points at a parent that is not in the list; `child` points at one that
// is, and must keep rendering where it belongs rather than doubling up at root.
const collections = [
	{ id: "root", name: "Acme", order: 0 },
	{ id: "child", name: "Billing", parentId: "root", order: 0 },
	{ id: "stray", name: "Orphaned", parentId: "deleted-parent", order: 1 },
];
const requests = new Map([
	["stray", [{ id: "r-stray", collectionId: "stray", name: "Lost", method: "GET", order: 0 }]],
]);

vi.mock("@/queries", () => ({
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
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["root", "stray"]) });
});

describe("a collection whose parent is not loaded", () => {
	it("renders at the top level instead of vanishing", () => {
		const { container } = renderTree();

		const rows = container.querySelectorAll('[role="tree"] > * > [data-collection-id]');
		expect([...rows].map((r) => r.getAttribute("data-collection-id"))).toEqual([
			"root",
			"stray",
		]);
	});

	it("brings its requests with it", () => {
		const { container } = renderTree();

		expect(container.querySelector('[data-request-id="r-stray"]')).not.toBeNull();
	});

	it("does not promote a collection whose parent is loaded", () => {
		const { container } = renderTree();

		// One row for `child`, and it is not a root: a filter that read "no parent
		// row rendered *yet*" rather than "no parent loaded" would duplicate it.
		expect(container.querySelectorAll('[data-collection-id="child"]')).toHaveLength(1);
		expect(
			container.querySelector('[role="tree"] > * > [data-collection-id="child"]')
		).toBeNull();
	});
});
