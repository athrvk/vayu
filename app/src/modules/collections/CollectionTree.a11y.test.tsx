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
 * What the collection tree exposes to a keyboard and to assistive tech.
 *
 * Three separate holes lived here. Every row was a bare `role="treeitem"` with
 * no level, position or set size, and a folder's children are rendered as a
 * *sibling* of its row rather than inside it - so the accessibility tree was a
 * flat list with no hierarchy to speak of at all. The Delete key was wired in
 * `useRovingTreeFocus` and preventDefault'ed, but only `RequestItem` rendered
 * the `data-tree-delete` control it clicks, so on a folder the key was swallowed
 * in silence. And closing a rename field with Enter or Escape unmounted the
 * focused element with nothing to catch focus, dropping the user out of the tree
 * and back to the top of the document.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

// Two roots; the first holds one subfolder and one request, so a group mixes
// both kinds of row and the request's position has to continue the folder's
// numbering rather than restart at 1.
const TREE = [
	{ id: "acme", name: "Acme", order: 0 },
	{ id: "beta", name: "Beta", order: 1 },
	{ id: "billing", name: "Billing", parentId: "acme", order: 0 },
];
const TREE_REQUESTS: Array<[string, Array<{ id: string; [key: string]: unknown }>]> = [
	["acme", [{ id: "r-ping", collectionId: "acme", name: "Ping", method: "GET", order: 0 }]],
];

// Mutable: a delete removes a row when the refetch lands, which is after the
// dialog has closed (#1234), and only a fixture that can shrink says so.
let collections = [...TREE];
let requests = new Map(TREE_REQUESTS);

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

let rerenderTree = () => {};

function renderTree() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// A fresh element per render: React skips reconciling a referentially equal
	// one, so a rerender with the same object would show none of the new data.
	const ui = () => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const view = render(ui());
	rerenderTree = () => act(() => view.rerender(ui()));
	return view;
}

/** The refetch a delete triggers, landing after the dialog has closed. */
function removeCollection(id: string) {
	collections = collections.filter((entry) => entry.id !== id);
	requests = new Map(TREE_REQUESTS.filter(([owner]) => owner !== id));
	rerenderTree();
}

function removeRequest(id: string) {
	requests = new Map(
		TREE_REQUESTS.map(([owner, rows]) => [owner, rows.filter((row) => row.id !== id)])
	);
	rerenderTree();
}

const collectionRow = (id: string) =>
	document.querySelector<HTMLElement>(`[data-collection-id="${id}"]`)!;
const requestRow = (id: string) =>
	document.querySelector<HTMLElement>(`[data-request-id="${id}"]`)!;

/** F2 on a focused row is the keyboard path into the rename field. */
function startRename(row: HTMLElement) {
	row.focus();
	fireEvent.keyDown(row, { key: "F2" });
	const field = row.querySelector<HTMLInputElement>("input");
	expect(field).not.toBeNull();
	return field!;
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	collections = [...TREE];
	requests = new Map(TREE_REQUESTS);
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["acme"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("the tree's shape as assistive tech sees it", () => {
	it("states each row's level, position and set size", () => {
		renderTree();

		// Two roots, level 1.
		expect(collectionRow("acme")).toHaveAttribute("aria-level", "1");
		expect(collectionRow("acme")).toHaveAttribute("aria-posinset", "1");
		expect(collectionRow("acme")).toHaveAttribute("aria-setsize", "2");
		expect(collectionRow("beta")).toHaveAttribute("aria-posinset", "2");
		expect(collectionRow("beta")).toHaveAttribute("aria-setsize", "2");

		// Inside Acme: one folder and one request are one set of two, and the
		// request is second. Numbering the requests separately would announce two
		// different "1 of 1" rows sitting next to each other.
		expect(collectionRow("billing")).toHaveAttribute("aria-level", "2");
		expect(collectionRow("billing")).toHaveAttribute("aria-posinset", "1");
		expect(collectionRow("billing")).toHaveAttribute("aria-setsize", "2");
		expect(requestRow("r-ping")).toHaveAttribute("aria-level", "2");
		expect(requestRow("r-ping")).toHaveAttribute("aria-posinset", "2");
		expect(requestRow("r-ping")).toHaveAttribute("aria-setsize", "2");
	});

	it("owns its children's group, which the DOM alone does not say", () => {
		renderTree();

		const owns = collectionRow("acme").getAttribute("aria-owns");
		expect(owns).toBeTruthy();
		const group = document.getElementById(owns!);
		// The group is a *sibling* of the row it belongs to, so without aria-owns
		// nothing connects the two and every row reads at the same depth.
		expect(group).toHaveAttribute("role", "group");
		expect(group!.contains(collectionRow("billing"))).toBe(true);
		expect(group!.contains(requestRow("r-ping"))).toBe(true);
	});

	it("drops the ownership claim when the folder is collapsed", () => {
		renderTree();
		// Beta has no children rendered - claiming to own a group that is not in
		// the DOM is a broken reference, not an empty one.
		expect(collectionRow("beta")).not.toHaveAttribute("aria-owns");
	});

	it("ships a live region that is present and empty", () => {
		renderTree();

		const live = document.querySelector('[aria-live="polite"][data-tree-live]');
		// Present: a live region added at the same moment as its first message is
		// not reliably announced, so the region has to outlive every message.
		expect(live).not.toBeNull();
		// Empty: nothing announces anything yet, and a region that ships with
		// filler would speak it on mount.
		expect(live!.textContent).toBe("");
	});
});

describe("ArrowLeft leaves the group", () => {
	// On the shipped DOM, not the hook's fixture: Ping is the *second* row of
	// Acme's group, which is the row the old parent walk got wrong - it took the
	// first treeitem the group held, so Left moved to Billing, the sibling above.
	it("moves to the owner row from a row that is not the group's first", () => {
		renderTree();

		requestRow("r-ping").focus();
		fireEvent.keyDown(requestRow("r-ping"), { key: "ArrowLeft" });

		expect(document.activeElement).toBe(collectionRow("acme"));
	});

	it("still moves to the owner row from the group's first", () => {
		renderTree();

		// Billing is collapsed, so Left moves rather than collapsing.
		collectionRow("billing").focus();
		fireEvent.keyDown(collectionRow("billing"), { key: "ArrowLeft" });

		expect(document.activeElement).toBe(collectionRow("acme"));
	});
});

describe("the Delete key", () => {
	it("opens the confirm dialog from a collection row", async () => {
		renderTree();
		const row = collectionRow("billing");
		row.focus();

		fireEvent.keyDown(row, { key: "Delete" });

		// The hook preventDefaults Delete either way, so without the row's hidden
		// control the key was swallowed and nothing at all happened.
		expect(await screen.findByText("Delete collection?")).toBeInTheDocument();
		expect(screen.getByText(/"Billing" and all its requests/)).toBeInTheDocument();
	});

	it("still opens the request dialog from a request row", async () => {
		renderTree();
		const row = requestRow("r-ping");
		row.focus();

		fireEvent.keyDown(row, { key: "Delete" });

		expect(await screen.findByText("Delete request?")).toBeInTheDocument();
	});
});

describe("a rename never strands focus", () => {
	it("returns focus to the collection row when Enter closes the field", async () => {
		renderTree();
		const row = collectionRow("billing");
		const field = startRename(row);

		fireEvent.keyDown(field, { key: "Enter" });

		await waitFor(() => expect(row.querySelector("input")).toBeNull());
		expect(document.activeElement).toBe(row);
	});

	it("returns focus to the collection row when Escape closes the field", async () => {
		renderTree();
		const row = collectionRow("billing");
		const field = startRename(row);

		fireEvent.keyDown(field, { key: "Escape" });

		await waitFor(() => expect(row.querySelector("input")).toBeNull());
		expect(document.activeElement).toBe(row);
	});

	it("returns focus to the request row when Enter closes the field", async () => {
		renderTree();
		const row = requestRow("r-ping");
		const field = startRename(row);

		fireEvent.keyDown(field, { key: "Enter" });

		await waitFor(() => expect(row.querySelector("input")).toBeNull());
		expect(document.activeElement).toBe(row);
	});

	it("returns focus to the request row when Escape closes the field", async () => {
		renderTree();
		const row = requestRow("r-ping");
		const field = startRename(row);

		fireEvent.keyDown(field, { key: "Escape" });

		await waitFor(() => expect(row.querySelector("input")).toBeNull());
		expect(document.activeElement).toBe(row);
	});

	it("leaves focus alone when the field is closed by a blur", async () => {
		renderTree();
		const row = collectionRow("billing");
		const field = startRename(row);

		// A blur means focus has already gone where the user sent it - here, the
		// other root row. Pulling it back to the tree would be worse than the bug
		// this fixes.
		collectionRow("beta").focus();
		fireEvent.blur(field);

		await waitFor(() => expect(row.querySelector("input")).toBeNull());
		expect(document.activeElement).toBe(collectionRow("beta"));
	});
});

/**
 * The delete half of the same defect the rename block above pins (#1218).
 *
 * A rename can hand focus back to its own row. A delete cannot - the row is the
 * thing that went - so the successor is chosen while the row is still on screen
 * and Radix's restore, which would aim at the deleted row, is overridden.
 */
describe("a delete never strands focus", () => {
	/**
	 * The keyboard path in: Delete on a focused row, then the confirm button -
	 * and then the removal itself, because the row goes when the refetch lands
	 * rather than when the dialog closes, and focus follows the row (#1234).
	 */
	async function deleteFromKeyboard(row: HTMLElement, title: string, removeRow: () => void) {
		row.focus();
		fireEvent.keyDown(row, { key: "Delete" });
		expect(await screen.findByText(title)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByText(title)).toBeNull());
		removeRow();
	}

	it("moves focus to the next row in the set", async () => {
		renderTree();

		// "Billing" is followed in Acme's group by the "Ping" request: the next
		// row at its own level, not the next row in the document.
		await deleteFromKeyboard(collectionRow("billing"), "Delete collection?", () =>
			removeCollection("billing")
		);

		expect(document.activeElement).toBe(requestRow("r-ping"));
	});

	it("moves focus to the parent when the last row in a set goes", async () => {
		renderTree();

		// "Ping" is last in Acme's group - the row after it belongs to the other
		// root, whose set this delete does not touch.
		await deleteFromKeyboard(requestRow("r-ping"), "Delete request?", () =>
			removeRequest("r-ping")
		);

		expect(document.activeElement).toBe(collectionRow("acme"));
	});

	it("puts the tree's tab stop on the row it focused", async () => {
		renderTree();

		await deleteFromKeyboard(collectionRow("billing"), "Delete collection?", () =>
			removeCollection("billing")
		);

		// Focus without the roving stop is a row the next Tab cannot return to.
		expect(requestRow("r-ping").tabIndex).toBe(0);
		expect(collectionRow("beta").tabIndex).toBe(-1);
	});

	it("falls back to the create control when the tree's last row goes", async () => {
		collections = [{ id: "solo", name: "Solo", order: 0 }];
		requests = new Map();
		renderTree();

		await deleteFromKeyboard(collectionRow("solo"), "Delete collection?", () => {
			collections = [];
			requests = new Map();
			rerenderTree();
		});

		// A root with no root after it and no parent has no successor to offer, and
		// `<body>` is where that answer used to end. "Add collection" is the
		// nearest thing that survives an emptied tree - and the only thing left to
		// do on one.
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add collection" }));
	});

	it("returns focus to the row when the dialog is cancelled", async () => {
		renderTree();
		const row = collectionRow("billing");
		row.focus();
		fireEvent.keyDown(row, { key: "Delete" });
		expect(await screen.findByText("Delete collection?")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		// Nothing was deleted, so the successor must not be where focus lands -
		// and Radix's own restore aims at a trigger this dialog does not have.
		await waitFor(() => expect(document.activeElement).toBe(row));
	});
});
