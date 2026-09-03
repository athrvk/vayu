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

	// Every key against both row types. A folder row missing what a request row
	// has is how the Delete key went dead here for months, so neither row type
	// gets to stand in for the other.
	const KEYS: [string, string, { shiftKey?: boolean }][] = [
		["Shift+F10", "F10", { shiftKey: true }],
		["the Menu key", "ContextMenu", {}],
		["Shift+Enter", "Enter", { shiftKey: true }],
	];
	const ROWS: [string, () => HTMLElement][] = [
		["a collection row", collectionRow],
		["a request row", requestRow],
	];

	for (const [rowName, row] of ROWS) {
		for (const [keyName, key, init] of KEYS) {
			it(`opens ${rowName}'s menu on ${keyName}`, async () => {
				renderTree();

				pressOnRow(row(), key, init);

				expect(await screen.findByRole("menu")).toBeInTheDocument();
				expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
			});
		}
	}

	it("offers a request row the actions that have no chord", async () => {
		renderTree();

		pressOnRow(requestRow(), "F10", { shiftKey: true });

		await screen.findByRole("menu");
		expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeInTheDocument();
	});

	it("leaves the row shut when Shift+Enter opens the menu", async () => {
		renderTree();

		pressOnRow(collectionRow(), "Enter", { shiftKey: true });

		await screen.findByRole("menu");
		// Shift+Enter is the menu, not a second way to activate the row.
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
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

	// Both row types, deliberately: a folder row missing a control the request
	// row had is how the Delete key went dead here for months.
	it("hands focus back to a request row too", async () => {
		renderTree();
		const row = requestRow();
		pressOnRow(row, "F10", { shiftKey: true });
		const menu = await screen.findByRole("menu");

		fireEvent.keyDown(menu, { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(row));
	});
});

describe("an action that opens a dialog", () => {
	/*
	 * Returning focus to the row is a claim on focus the menu did not use to
	 * make, and most row actions open a dialog. Radix runs the close's focus
	 * restoration on a later tick than the dialog's own mount focus, so the row
	 * would be claiming focus a dialog has already taken - and nothing in the
	 * tree's tests asserted where focus lands, so this went unmeasured.
	 */
	it("leaves focus in the dialog, not on the row behind it", async () => {
		renderTree();
		const row = collectionRow();
		pressOnRow(row, "F10", { shiftKey: true });
		fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));

		const dialog = await screen.findByRole("dialog");

		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
		expect(document.activeElement).not.toBe(row);
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
