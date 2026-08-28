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
 * The undo the confirm dialog promises (issue #989).
 *
 * The dialog has said "moved to the Trash, where it can be restored" since the
 * engine's delete went soft (#988/#1045), and for a while nothing in the app
 * could restore anything: the delete succeeded silently and the sentence was a
 * claim about a surface that did not exist.
 *
 * Two halves are asserted here, and the second is the one that decides whether
 * the affordance is honest. A toast offering Undo is easy; an Undo that fails
 * silently - because the parent collection has since been deleted too, or
 * retention swept the row - is worse than none, because the user walks away
 * believing the item is back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const deleteCollection = vi.fn();
const deleteRequest = vi.fn();
const restoreTrash = vi.fn();
const showToast = vi.fn();

const collections = [{ id: "root", name: "Acme", order: 0 }];
const requests = new Map([
	["root", [{ id: "r-root", collectionId: "root", name: "Ping", method: "GET", order: 0 }]],
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
	useDeleteCollectionMutation: () => ({ mutateAsync: deleteCollection, isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: deleteRequest, isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: restoreTrash, isPending: false }),
}));

// Only the toast store is replaced; `useTabsStore` and the rest stay real,
// because the delete path drives them and the assertions below rely on it.
vi.mock("@/stores", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useToastStore: Object.assign(
			(selector: (s: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
			{ getState: () => ({ showToast }) }
		),
	};
});

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

/** Delete from a collection row's ⋯ menu. Radix opens on pointerdown. */
async function askToDeleteCollection(name: string) {
	fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${name}` }), {
		button: 0,
		ctrlKey: false,
		pointerType: "mouse",
	});
	fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
	fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
}

/** The options object handed to the last `showToast` call. */
function lastToast() {
	const call = showToast.mock.calls.at(-1);
	return call?.[0];
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	deleteCollection.mockReset().mockResolvedValue(undefined);
	deleteRequest.mockReset().mockResolvedValue(undefined);
	restoreTrash.mockReset().mockResolvedValue({
		id: "root",
		kind: "collection",
		name: "Acme",
		deletedAt: 1,
		parentId: null,
		collections: 0,
		requests: 0,
		restored: true,
		reparentedToRoot: false,
	});
	showToast.mockReset();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["root"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("deleting from the tree", () => {
	it("says where the collection went, and offers it back", async () => {
		renderTree();
		await askToDeleteCollection("Acme");

		await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith("root"));
		await waitFor(() => expect(showToast).toHaveBeenCalled());

		const toast = lastToast();
		// The name, because "Moved to the Trash" after a multi-select-shaped tree
		// leaves the user guessing which row went.
		expect(toast.message).toContain("Acme");
		expect(toast.message).toMatch(/trash/i);
		expect(toast.action?.label).toBe("Undo");
	});

	it("restores the very row it deleted when Undo is pressed", async () => {
		renderTree();
		await askToDeleteCollection("Acme");
		await waitFor(() => expect(showToast).toHaveBeenCalled());

		lastToast().action.onClick();

		// The id, not the name: restore addresses the trash entry, and the entry
		// keeps the deleted row's own id.
		await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith("root"));
	});

	it("raises the engine's own refusal when the undo cannot be honoured", async () => {
		// What a 409 says when the item's collection has since been deleted too.
		// The wording is the engine's, and naming the blocking collection is the
		// whole value of it - an invented "Couldn't restore" would not.
		restoreTrash.mockRejectedValue(
			new Error(
				"Request 'r-root' cannot be restored on its own - the collection it belongs to is in the trash, so restore that first"
			)
		);
		renderTree();
		await askToDeleteCollection("Acme");
		await waitFor(() => expect(showToast).toHaveBeenCalled());

		lastToast().action.onClick();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("restore that first"),
				"error"
			)
		);
	});

	it("offers no undo when the delete itself failed", async () => {
		// Nothing was deleted, so there is nothing in the trash to restore - an
		// Undo here would 404 against a row that never left the tree.
		deleteCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		await askToDeleteCollection("Acme");

		await waitFor(() => expect(deleteCollection).toHaveBeenCalled());
		expect(showToast).not.toHaveBeenCalled();
	});
});
