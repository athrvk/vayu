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
 * Switching to a collection tab has to reveal that collection in the tree.
 *
 * Reported as "the collection detail loads but the sidebar does not open",
 * against settings and request tabs which both did. The Shell's drawer effect
 * was not the cause - it treats collection and request identically - the tree's
 * own reveal effect was, because it only ever handled a *request*: it walked up
 * from the request's owning collection and expanded that chain. A collection
 * tab expanded nothing, so a collection nested inside a collapsed parent had no
 * row rendered at all. Nothing to highlight, nothing to scroll to, and the
 * sidebar looked inert.
 *
 * `selectedCollectionId` was being computed and then used only for a label and
 * a highlight - a value written and never read for the thing it was needed for,
 * which is this codebase's most repeated defect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

/** root > child > grandchild, so an ancestor chain actually has to be walked. */
const root = { id: "root", name: "Acme", order: 0 };
const child = { id: "child", name: "Billing", parentId: "root", order: 0 };
const grandchild = { id: "grand", name: "Invoices", parentId: "child", order: 0 };
const request = { id: "r1", collectionId: "grand", name: "Get invoice", method: "GET", order: 0 };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: [root, child, grandchild],
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["grand", [request]]]),
	}),
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

/** The store holds a Set; `[...]` keeps the assertions readable. */
const expanded = () => [...useCollectionsStore.getState().expandedCollectionIds];

// jsdom implements no scrolling. The reveal effect calls this once a row
// exists, which these tests are the first to actually reach.
beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	// Everything collapsed: the state in which the bug is visible at all.
	useCollectionsStore.setState({ expandedCollectionIds: new Set<string>() });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("revealing the active tab in the tree", () => {
	it("expands a selected collection's ancestors so its row exists", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "grand" }],
			activeTabId: "t1",
		});
		renderTree();

		// Without the ancestors, the row is never rendered - which is exactly what
		// "the sidebar does not open" looked like.
		expect(expanded()).toContain("root");
		expect(expanded()).toContain("child");
		expect(expanded()).toContain("grand");
	});

	it("renders the selected collection's row, addressable for scrolling", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "grand" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		expect(container.querySelector('[data-collection-id="grand"]')).not.toBeNull();
	});

	it("still reveals a selected request, by expanding its owning chain", () => {
		// The behaviour that already worked, kept working - the reveal was
		// generalised rather than swapped over.
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		renderTree();
		expect(expanded()).toContain("root");
		expect(expanded()).toContain("child");
		expect(expanded()).toContain("grand");
	});

	it("expands nothing for a tab that points at neither", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "settings", entityId: null }],
			activeTabId: "t1",
		});
		renderTree();
		expect(expanded()).toEqual([]);
	});
});
