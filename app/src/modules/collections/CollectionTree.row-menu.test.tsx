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
 * The row menu, opened the way a keyboard opens it (#1212).
 *
 * `useRovingTreeFocus` answers Shift+F10, the Menu key and Shift+Enter by
 * calling `.click()` on the row's `[data-tree-menu]` control. Radix's dropdown
 * trigger listens on `pointerdown` and on its own `keydown` and hears neither -
 * so Duplicate, Move to, Run, Add and Export were mouse-only on every row while
 * the tree advertised a keyboard path for them.
 *
 * The hook's own test could not see it: it renders a stub row whose
 * `data-tree-menu` control is a plain button, so `.click()` there does what
 * `.click()` on a plain button always does. These cases press the same keys on
 * the real tree, against the real menu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const collections = [{ id: "acme", name: "Acme", order: 0 }];
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
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

const collectionRow = () => document.querySelector<HTMLElement>('[data-collection-id="acme"]')!;
const requestRow = () => document.querySelector<HTMLElement>('[data-request-id="r-ping"]')!;

/** Focus a row and press one of the three keys the hook routes to the menu. */
function pressOnRow(row: HTMLElement, key: string, init: { shiftKey?: boolean } = {}) {
	row.focus();
	fireEvent.keyDown(row, { key, ...init });
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["acme"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("the three keys that open a row's menu", () => {
	it("opens a collection row's menu on Shift+F10", async () => {
		renderTree();

		pressOnRow(collectionRow(), "F10", { shiftKey: true });

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		// The menu-only actions the issue names: none of them has a chord, so
		// this menu is the whole keyboard path to them.
		expect(screen.getByRole("menuitem", { name: /Run collection/ })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: /Add Request/ })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: /Export as OpenAPI/ })).toBeInTheDocument();
	});

	it("opens it on the Menu key", async () => {
		renderTree();

		pressOnRow(collectionRow(), "ContextMenu");

		expect(await screen.findByRole("menu")).toBeInTheDocument();
	});

	it("opens it on Shift+Enter, the Mac-reachable path, without opening the row", async () => {
		renderTree();

		pressOnRow(collectionRow(), "Enter", { shiftKey: true });

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		// Shift+Enter is the menu, not a second way to activate the row.
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("opens a request row's menu too", async () => {
		renderTree();

		pressOnRow(requestRow(), "F10", { shiftKey: true });

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeInTheDocument();
	});
});

describe("moving around the menu once it is open", () => {
	it("puts the first action under the arrow keys", async () => {
		renderTree();
		pressOnRow(collectionRow(), "F10", { shiftKey: true });
		const menu = await screen.findByRole("menu");

		fireEvent.keyDown(menu, { key: "ArrowDown" });

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0])
		);
	});

	it("hands focus back to the row on Escape", async () => {
		renderTree();
		const row = collectionRow();
		pressOnRow(row, "F10", { shiftKey: true });
		const menu = await screen.findByRole("menu");

		fireEvent.keyDown(menu, { key: "Escape" });

		// Not the trigger: it is `tabIndex={-1}` inside the tree's single tab
		// stop, so focus resting there is focus the user cannot Tab back to.
		await waitFor(() => expect(document.activeElement).toBe(row));
	});
});

describe("the tree stays one tab stop", () => {
	it("keeps every row control off the tab order, the ⋯ trigger included", () => {
		renderTree();

		const menus = document.querySelectorAll<HTMLElement>("[data-tree-menu]");
		expect(menus.length).toBeGreaterThan(0);
		for (const menu of menus) expect(menu).toHaveAttribute("tabindex", "-1");
	});
});
