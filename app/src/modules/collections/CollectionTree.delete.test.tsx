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
 * What a collection delete does, with and without a dialog in front of it.
 *
 * A delete is a soft delete with an undo toast behind it, so it runs the moment
 * it is asked for. The one exception is a collection with a mock server running
 * for it: the engine stops the mock as part of the delete (#3449) and Undo does
 * not start it again, so that delete asks first,
 * and its dialog stays up with `isDeleting` spent on a spinner and a disabled
 * pair of buttons until the delete settles.
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
const deleteRequest = vi.fn();

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
 * delete has settled - the timing the refocus has to survive (#1234), and one a
 * fixed fixture cannot express.
 */
let collections = [...TREE];
let requests = new Map(TREE_REQUESTS);
/** No mocks running unless a test says otherwise. */
let mockServers: Array<{
	mockId: string;
	collectionId: string;
	collectionName: string;
	port: number;
}> = [];

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
	useDeleteRequestMutation: () => ({ mutateAsync: deleteRequest, isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: mockServers }),
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
		/** The refetch that follows a delete, landing after it has settled. */
		refetchWithout(collectionId: string) {
			collections = collections.filter((entry) => entry.id !== collectionId);
			requests = new Map(TREE_REQUESTS.filter(([owner]) => owner !== collectionId));
			act(() => view.rerender(ui()));
		},
		/** The same, for a request. */
		refetchWithoutRequest(collectionId: string, requestId: string) {
			requests = new Map(
				[...requests].map(([owner, list]) => [
					owner,
					owner === collectionId ? list.filter((entry) => entry.id !== requestId) : list,
				])
			);
			act(() => view.rerender(ui()));
		},
		/** A render with nothing changed, the kind the delete's own state causes. */
		rerender() {
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

const confirmButton = () => screen.findByRole("button", { name: /^Delete collection$/ });
const cancelButton = () => screen.queryByRole("button", { name: /^Cancel$/ });

beforeEach(() => {
	// jsdom implements no scrolling; the reveal effect calls it for an open tab.
	Element.prototype.scrollIntoView = vi.fn();
	deleteCollection.mockReset().mockResolvedValue(undefined);
	deleteRequest.mockReset().mockResolvedValue(undefined);
	collections = [...TREE];
	requests = new Map(TREE_REQUESTS);
	mockServers = [];
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["root", "mid", "leaf"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

/** Every mock in `mockServers` belongs to "Invoices", the collection deleted. */
function runMockOnInvoices() {
	mockServers = [
		{ mockId: "mock-1", collectionId: "leaf", collectionName: "Invoices", port: 4123 },
	];
}

/** The delete has been sent and its `finally` has run. */
async function deleteSettled() {
	await waitFor(() => expect(deleteCollection).toHaveBeenCalled());
	await act(async () => {});
}

describe("deleting a collection with nothing running", () => {
	it("deletes straight away, with no dialog to confirm", async () => {
		renderTree();
		await askToDelete("Invoices");

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("leaf"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(cancelButton()).toBeNull();
	});

	/*
	 * Where focus goes once the delete has run (#1218). The menu item it was
	 * invoked from has unmounted with the menu, and with no dialog there is no
	 * close to hang the refocus on, so without an explicit hand-off focus lands
	 * on `<body>` and the next Tab restarts from the top of the document.
	 *
	 * The move waits for the row to actually go (#1234): the delete settles
	 * before the refetch that removes the row, so until then the row is still
	 * rendered and is where focus belongs.
	 */
	it("leaves focus on the row that follows the deleted one, once that row is gone", async () => {
		const view = renderTree();
		await askToDelete("Invoices");

		await deleteSettled();
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
	 * the delete's `finally` has run.
	 */
	it("moves focus to the successor when the row went before the delete settled", async () => {
		let view: ReturnType<typeof renderTree> | null = null;
		deleteCollection.mockImplementation(() => {
			view?.refetchWithout("leaf");
			return Promise.resolve();
		});
		view = renderTree();
		await askToDelete("Invoices");

		await deleteSettled();
		expect(document.activeElement).toBe(document.querySelector('[data-request-id="r-mid"]'));
	});

	/*
	 * The row a failed delete did not remove is still the row the user was on,
	 * and it is still there to be focused (#1234).
	 */
	it("leaves focus on the row when the delete fails", async () => {
		deleteCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDelete("Invoices");

		await deleteSettled();
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
		await deleteSettled();

		const elsewhere = document.querySelector<HTMLElement>('[data-collection-id="root"]')!;
		elsewhere.focus();

		view.refetchWithout("leaf");

		expect(document.activeElement).toBe(elsewhere);
	});

	/*
	 * The delete is sent by an effect, and the delete's own state changes
	 * re-render the tree while it runs: each of those must not send it again.
	 */
	it("sends the delete once, however often the tree renders while it runs", async () => {
		let settle: () => void = () => {};
		deleteCollection.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			})
		);
		const view = renderTree();
		await askToDelete("Invoices");
		await waitFor(() => expect(deleteCollection).toHaveBeenCalled());

		view.rerender();
		view.rerender();
		settle();
		await act(async () => {});

		expect(deleteCollection).toHaveBeenCalledTimes(1);
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

		// The nested request two levels down is the one a single-level cascade
		// would leave open on a row the engine has already removed.
		await waitFor(() => expect(useTabsStore.getState().openTabs).toEqual([]));
	});

	/*
	 * A delete requested while another is still running used to be lost outright:
	 * the in-flight delete's `finally` cleared `deleteConfirm` unconditionally,
	 * wiping out whichever delete had queued up behind it, with no dialog and no
	 * toast to show for it. The fix is a guarded clear in `useTreeCrud`, so the
	 * queued delete survives to be sent once the first one settles.
	 */
	it("delivers a delete requested while another is still in flight, instead of losing it", async () => {
		let settleFirst: () => void = () => {};
		deleteCollection.mockImplementation((id: unknown) => {
			if (id === "leaf") {
				return new Promise<void>((resolve) => {
					settleFirst = resolve;
				});
			}
			return Promise.resolve();
		});
		renderTree();
		await askToDelete("Invoices");
		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("leaf"));

		await askToDelete("Acme");
		// Queued behind "leaf": refused for as long as it is still in flight.
		await act(async () => {});
		expect(deleteCollection).not.toHaveBeenCalledWith("root");

		settleFirst();
		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("root"));
	});

	it("does not mention a mock running for an unrelated collection", async () => {
		mockServers = [
			{ mockId: "mock-other", collectionId: "root", collectionName: "Acme", port: 5000 },
		];
		renderTree();
		await askToDelete("Invoices");

		await deleteSettled();
		expect(deleteCollection).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/mock server/i)).not.toBeInTheDocument();
	});
});

/*
 * A collection can have a mock server running for it. Deleting it - or a
 * parent whose descendant has one - stops that mock as part of the delete
 * (the engine does it, #3449), and that is the one part Undo cannot give back,
 * so this delete alone asks first and says so. The renderer sends no stop of
 * its own: this file's `@/queries` mock carries no stop mutation, so a hook
 * that reaches for one fails to render. `mockServers` is set per test rather than in
 * `beforeEach`, so the default stays the "no mock" case above.
 */
/*
 * A request row's menu used to unmount while its delete ran, taking the menu's
 * own focus hand-back with it: the removed row then left focus on `<body>`
 * (#3443). The collection row's menu stays mounted, which is the shape this
 * pins for requests.
 */
describe("deleting a request from its menu", () => {
	async function askToDeleteRequest(name: string) {
		fireEvent.pointerDown(
			screen.getByRole("button", { name: `More actions for request ${name}` }),
			{ button: 0, ctrlKey: false, pointerType: "mouse" }
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
		await waitFor(() => expect(deleteRequest).toHaveBeenCalled());
		await act(async () => {});
	}

	it("moves focus to the row that follows it once the request is gone", async () => {
		const view = renderTree();
		await askToDeleteRequest("Charge");

		view.refetchWithoutRequest("mid", "r-mid");

		// "Charge" was the last row in Billing, so its parent is the successor.
		expect(document.activeElement).toBe(document.querySelector('[data-collection-id="mid"]'));
	});

	it("leaves focus on the request when the delete fails", async () => {
		deleteRequest.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDeleteRequest("Charge");

		expect(document.activeElement).toBe(document.querySelector('[data-request-id="r-mid"]'));
	});
});

describe("deleting a collection with a mock server running", () => {
	it("asks first, and deletes nothing until confirmed", async () => {
		runMockOnInvoices();
		renderTree();
		await askToDelete("Invoices");

		expect(await confirmButton()).toBeInTheDocument();
		expect(deleteCollection).not.toHaveBeenCalled();
	});

	it("warns in the dialog when the deleted collection itself has a running mock", async () => {
		runMockOnInvoices();
		renderTree();
		await askToDelete("Invoices");

		expect(await screen.findByText(/port 4123/)).toBeInTheDocument();
	});

	it("warns when a descendant sub-collection has the running mock, not just the collection itself", async () => {
		runMockOnInvoices();
		renderTree();
		// "Acme" is root; "leaf" (Invoices) is two levels below it.
		await askToDelete("Acme");

		expect(await screen.findByText(/port 4123/)).toBeInTheDocument();
	});

	it("keeps the dialog up, with both actions disabled, until the delete settles", async () => {
		runMockOnInvoices();
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
		// buttons are disabled.
		await waitFor(() => expect(cancelButton()).toBeDisabled());

		settle();

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
	});

	it("closes the dialog when the delete fails, having reported it", async () => {
		runMockOnInvoices();
		deleteCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
	});

	it("leaves focus on the row that follows the deleted one, once the dialog closes and the row goes", async () => {
		runMockOnInvoices();
		const view = renderTree();
		await askToDelete("Invoices");

		fireEvent.click(await confirmButton());

		await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
		expect(document.activeElement).toBe(document.querySelector('[data-collection-id="leaf"]'));

		view.refetchWithout("leaf");

		expect(document.activeElement).toBe(document.querySelector('[data-request-id="r-mid"]'));
	});

	it("cannot fire the same delete twice from a double click", async () => {
		runMockOnInvoices();
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
		// the frame the dialog stays open for.
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		settle();

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledTimes(1));
	});

	it("says the mock will be stopped, and leaves the stopping to the engine's delete", async () => {
		runMockOnInvoices();
		renderTree();
		await askToDelete("Invoices");

		expect(await screen.findByText(/it will be stopped/)).toBeInTheDocument();
		fireEvent.click(await confirmButton());

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("leaf"));
	});

	it("warns about every affected mock in a cascade, not just the top-level collection's own", async () => {
		mockServers = [
			{ mockId: "mock-root", collectionId: "root", collectionName: "Acme", port: 4000 },
			{ mockId: "mock-leaf", collectionId: "leaf", collectionName: "Invoices", port: 4123 },
		];
		renderTree();
		await askToDelete("Acme");

		expect(await screen.findByText(/2 mock servers are running/)).toBeInTheDocument();
		fireEvent.click(await confirmButton());

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("root"));
	});
});
