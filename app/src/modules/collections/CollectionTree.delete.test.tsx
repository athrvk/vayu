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
 * What the confirm dialog does while the delete it confirmed is running.
 *
 * `DeleteConfirmDialog` takes an `isDeleting` prop and spends it on a spinner
 * and a disabled pair of buttons - and it could never be true here, because both
 * delete handlers closed the dialog as their very first act. The user confirmed
 * a cascade delete of a folder and got an instantly-empty dialog with the tree
 * unchanged until the round trip landed.
 *
 * The cascade list is the other half: closing tabs for a deleted folder has to
 * reach requests nested two levels down, which the walk in `tree-utils` is now
 * responsible for.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const deleteCollection = vi.fn();

// root > mid > leaf, each holding one request. Deleting `root` cascades over
// all of it.
const TREE = [
	{ id: "root", name: "Acme", order: 0 },
	{ id: "mid", name: "Billing", parentId: "root", order: 0 },
	{ id: "leaf", name: "Invoices", parentId: "mid", order: 0 },
];
const TREE_REQUESTS: Array<[string, Array<Record<string, unknown>>]> = [
	["root", [{ id: "r-root", collectionId: "root", name: "Ping", method: "GET", order: 0 }]],
	["mid", [{ id: "r-mid", collectionId: "mid", name: "Charge", method: "POST", order: 0 }]],
	["leaf", [{ id: "r-leaf", collectionId: "leaf", name: "List", method: "GET", order: 0 }]],
];

/*
 * Mutable, so a test can answer differently once the delete has settled. The
 * engine's refetch is what removes a deleted row, and it lands *after* the
 * dialog has closed - the timing the refocus has to survive (#1234), and one a
 * fixed fixture cannot express.
 */
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
	useDeleteCollectionMutation: () => ({ mutateAsync: deleteCollection, isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

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

	return {
		...view,
		/** The refetch that follows a delete, landing after the dialog is gone. */
		refetchWithout(collectionId: string) {
			collections = collections.filter((entry) => entry.id !== collectionId);
			requests = new Map(TREE_REQUESTS.filter(([owner]) => owner !== collectionId));
			act(() => view.rerender(ui()));
		},
	};
}

/**
 * Delete from the row's ⋯ menu - the only way in on a collection row today, the
 * keyboard path being dead until the accessibility batch (#362) wires
 * `data-tree-delete` on `CollectionItem` the way `RequestItem` already has it.
 * Radix opens on pointerdown, not click.
 */
async function askToDelete(collectionName: string) {
	fireEvent.pointerDown(
		screen.getByRole("button", { name: `More actions for ${collectionName}` }),
		{ button: 0, ctrlKey: false, pointerType: "mouse" }
	);
	fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
}

const confirmButton = () => screen.findByRole("button", { name: /^Delete$/ });
const cancelButton = () => screen.queryByRole("button", { name: /^Cancel$/ });

beforeEach(() => {
	// jsdom implements no scrolling; the reveal effect calls it for an open tab.
	Element.prototype.scrollIntoView = vi.fn();
	deleteCollection.mockReset().mockResolvedValue(undefined);
	collections = [...TREE];
	requests = new Map(TREE_REQUESTS);
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["root", "mid", "leaf"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("confirming a collection delete", () => {
	it("keeps the dialog up, with both actions disabled, until the delete settles", async () => {
		let settle: () => void = () => {};
		deleteCollection.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			})
		);
		renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		// In flight: the dialog is the only thing on screen saying so, and its
		// buttons are disabled - which `isDeleting` could never make them, because
		// the dialog was already unmounted by this point.
		await waitFor(() => expect(cancelButton()).toBeDisabled());

		settle();

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
	});

	it("closes the dialog when the delete fails, having reported it", async () => {
		deleteCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
	});

	/*
	 * Where focus goes once the dialog is gone (#1218). The menu item that
	 * opened it has unmounted with the menu, and the dialog is controlled with
	 * no trigger for Radix to restore to, so without this focus lands on
	 * `<body>` and the next Tab restarts from the top of the document.
	 *
	 * The move waits for the row to actually go (#1234): the delete settles
	 * before the refetch that removes the row, so at close the row is still
	 * rendered and is where focus belongs until it is not.
	 */
	it("leaves focus on the row that follows the deleted one, once that row is gone", async () => {
		const view = renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
		expect(document.activeElement).toBe(document.querySelector('[data-collection-id="leaf"]'));

		view.refetchWithout("leaf");

		// "Invoices" was followed in Billing's group by the "Charge" request: the
		// next row at its own level, not the next row in the document, which was
		// the request inside the folder being deleted.
		expect(document.activeElement).toBe(document.querySelector('[data-request-id="r-mid"]'));
	});

	/*
	 * The other order, and the one the real mutation produces: it drops the id
	 * from the cached list in its own `onSuccess`, so the row can be gone before
	 * the `finally` closes the dialog. Then there is nothing to defer to and the
	 * successor is where focus goes at close.
	 */
	it("moves focus to the successor when the row went before the dialog closed", async () => {
		let view: ReturnType<typeof renderTree> | null = null;
		deleteCollection.mockImplementation(() => {
			view?.refetchWithout("leaf");
			return Promise.resolve();
		});
		view = renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
		expect(document.activeElement).toBe(document.querySelector('[data-request-id="r-mid"]'));
	});

	/*
	 * The row a failed delete did not remove is still the row the user was on,
	 * and it is still there to be focused. Reading the confirm click as the
	 * outcome sent focus to the successor instead, beside a surviving row
	 * (#1234).
	 */
	it("leaves focus on the row when the delete fails", async () => {
		deleteCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
		expect(document.activeElement).toBe(document.querySelector('[data-collection-id="leaf"]'));
	});

	/*
	 * The deferred move is for a user who is still where the delete left them.
	 * One who has moved on has chosen where focus is, and the refetch landing is
	 * no reason to take it back.
	 */
	it("does not chase the successor when focus has moved on before the row goes", async () => {
		const view = renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());
		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());

		const elsewhere = document.querySelector<HTMLElement>('[data-collection-id="root"]')!;
		elsewhere.focus();

		view.refetchWithout("leaf");

		expect(document.activeElement).toBe(elsewhere);
	});

	it("cannot fire the same delete twice from a double click", async () => {
		let settle: () => void = () => {};
		deleteCollection.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			})
		);
		renderTree();
		await askToDelete("Invoices");
		const confirm = await confirmButton();

		// Both clicks land before React can re-render the button as disabled -
		// the frame the dialog now stays open for.
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		settle();

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledTimes(1));
	});

	it("closes the tabs of every descendant folder and request, not just the top level", async () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "collection", entityId: "root" },
				{ id: "t2", type: "collection", entityId: "leaf" },
				{ id: "t3", type: "request", entityId: "r-leaf" },
				{ id: "t4", type: "request", entityId: "r-mid" },
			],
			activeTabId: "t1",
		});
		renderTree();
		await askToDelete("Acme");

		fireEvent.click(await confirmButton());

		// The nested request two levels down is the one a single-level cascade
		// would leave open on a row the engine has already removed.
		await waitFor(() => expect(useTabsStore.getState().openTabs).toEqual([]));
	});
});
