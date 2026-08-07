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
import { render, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import type { Tab } from "@/stores/tabs-store";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

/** root > child > grandchild, so an ancestor chain actually has to be walked. */
const root = { id: "root", name: "Acme", order: 0 };
const child = { id: "child", name: "Billing", parentId: "root", order: 0 };
const grandchild = { id: "grand", name: "Invoices", parentId: "child", order: 0 };
const request = { id: "r1", collectionId: "grand", name: "Get invoice", method: "GET", order: 0 };

/**
 * Mutable so a test can render before the per-collection request lists have
 * arrived and swap them in afterwards - the state every cold start passes
 * through, and the one the reveal has to survive.
 */
let requestsByCollection = new Map<string, Array<typeof request>>();

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: [root, child, grandchild],
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	// A fresh Map per call, exactly as the real hook once did - which is what
	// made the reveal effect re-run after every render.
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map(requestsByCollection),
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
const scrollIntoView = vi.fn();

beforeEach(() => {
	scrollIntoView.mockClear();
	Element.prototype.scrollIntoView = scrollIntoView;
	// Everything collapsed: the state in which the bug is visible at all.
	useCollectionsStore.setState({ expandedCollectionIds: new Set<string>() });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	requestsByCollection = new Map([["grand", [request]]]);
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

/**
 * The reveal has to be once per *selection*, not once per render.
 *
 * The mock above returns a new `Map` on every call, which is what
 * `useMultipleCollectionRequests` used to do for real - and the tree re-renders
 * on any expand-state change, so the reveal effect re-ran and re-expanded the
 * chain a frame after the chevron collapsed it. Every ancestor of the active
 * tab's entity was pinned open and the chevron looked dead.
 */
describe("collapsing a collection on the selected tab's ancestor path", () => {
	const collapse = (container: HTMLElement, collectionId: string) => {
		const toggle = container.querySelector(
			`[data-collection-id="${collectionId}"] [data-tree-toggle]`
		);
		expect(toggle).not.toBeNull();
		fireEvent.click(toggle!);
	};

	const selectTab = (tab: Tab) =>
		act(() => {
			useTabsStore.setState({ openTabs: [tab], activeTabId: tab.id });
		});

	it("stays collapsed while the selected request is unchanged", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		expect(expanded()).toContain("grand");

		collapse(container, "grand");

		// Before the ref guard this re-expanded in the same frame.
		expect(expanded()).not.toContain("grand");
		// The rest of the chain is untouched - collapsing one folder is not a
		// reason to close its parents.
		expect(expanded()).toContain("root");
		expect(expanded()).toContain("child");
	});

	it("stays collapsed while the selected collection is unchanged", () => {
		// The ancestor case: `child` holds the selected collection `grand`.
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "grand" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		expect(expanded()).toContain("child");

		collapse(container, "child");

		expect(expanded()).not.toContain("child");
	});

	it("re-reveals after the selection moves away and back", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		collapse(container, "grand");
		expect(expanded()).not.toContain("grand");

		// Once per selection means once per selection *change*: a tab that points
		// at nothing in the tree, then back to the request, is a new selection.
		selectTab({ id: "t2", type: "settings", entityId: null });
		selectTab({ id: "t1", type: "request", entityId: "r1" });

		expect(expanded()).toContain("grand");
	});

	it("does not scroll again when an unrelated folder is collapsed", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		// `root` holds no part of the selection's row; collapsing it re-renders
		// the tree, and an unguarded scroll effect would yank the view back to a
		// row the user just navigated away from.
		collapse(container, "root");

		expect(scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it("scrolls again once the selection actually changes", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		renderTree();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		selectTab({ id: "t2", type: "collection", entityId: "child" });

		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});

	it("re-reveals when the selection moves to a different entity", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		const { container } = renderTree();
		collapse(container, "child");
		expect(expanded()).not.toContain("child");

		selectTab({ id: "t2", type: "collection", entityId: "grand" });

		expect(expanded()).toContain("child");
		expect(expanded()).toContain("grand");
	});
});

/**
 * On a cold start the tabs are restored before the per-collection request lists
 * land, so the owning collection of a selected request is unknown for the first
 * render or two. The effect must treat that as "not yet", not as "done" - it
 * leaves its ref unset so the reveal happens when the data arrives.
 */
describe("revealing a request whose collection has not loaded yet", () => {
	it("expands nothing while the lists are empty, then reveals when they arrive", () => {
		requestsByCollection = new Map();
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		const { rerender } = renderTree();

		// Nothing to walk up from: the request belongs to no known collection.
		expect(expanded()).toEqual([]);

		requestsByCollection = new Map([["grand", [request]]]);
		act(() => {
			rerender(
				<QueryClientProvider client={new QueryClient()}>
					<TooltipProvider>
						<CollectionTree />
					</TooltipProvider>
				</QueryClientProvider>
			);
		});

		expect(expanded()).toContain("root");
		expect(expanded()).toContain("child");
		expect(expanded()).toContain("grand");
	});
});
