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
 * Deleting a saved example moves it to the Trash (#2971).
 *
 * The engine trashes a user-saved example and keeps an imported one as a
 * spec-sync tombstone, so the two deletes say different things: the dialog
 * names the Trash for the first and the spec-sync consequence for the second,
 * and only the first raises the "Moved to the Trash" toast with an Undo. The
 * Undo has to be a restore of the example's own id, and the list the user is
 * looking at has to refetch to show the row again.
 *
 * Real query hooks and a real toast store, only `apiService` stubbed: what is
 * under test is the wiring from the panel through `useTrashUndo` and the
 * restore mutation's invalidation to the list, which a replaced `@/queries`
 * could not see.
 *
 * Mutation checks: drop the `offerUndo` call from `confirmDelete` and the toast
 * cases fail; put "This can't be undone." back into `exampleDeleteDescription`
 * and the saved-row dialog case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useToastStore } from "@/stores";
import { RequestBuilderContext } from "../../../context/RequestBuilderContext";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { RequestExample } from "@/types";
import ExamplesPanel from "./ExamplesPanel";

const getRequest = vi.fn();
const listRequestExamples = vi.fn();
const listCollections = vi.fn();
const deleteRequestExample = vi.fn();
const restoreTrashEntry = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: (id: string) => getRequest(id),
		listRequestExamples: (id: string) => listRequestExamples(id),
		listCollections: () => listCollections(),
		deleteRequestExample: (requestId: string, exampleId: string) =>
			deleteRequestExample(requestId, exampleId),
		restoreTrashEntry: (id: string) => restoreTrashEntry(id),
		updateRequest: vi.fn(),
	},
}));

const SAVED: RequestExample = {
	id: "exa_saved",
	name: "Happy path",
	status: 200,
	headers: [],
	body: "{}",
	contentType: "application/json",
	origin: "user",
};
const IMPORTED: RequestExample = {
	...SAVED,
	id: "exa_imported",
	name: "From the spec",
	origin: "import",
};

function renderPanel() {
	const value = {
		request: { ...createDefaultRequestState(), id: "req_1" },
		updateField: vi.fn(),
		setRequest: vi.fn(),
		activeTab: "examples",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	render(
		<QueryClientProvider client={client}>
			<RequestBuilderContext.Provider value={value}>
				<ExamplesPanel />
			</RequestBuilderContext.Provider>
		</QueryClientProvider>
	);
	return client;
}

/** The toast the delete raised, read off the real store. */
function trashToast() {
	return useToastStore.getState().toasts.find((t) => t.message.includes("to the Trash"));
}

async function deleteExample(name: string) {
	fireEvent.click(await screen.findByRole("button", { name: `Delete example ${name}` }));
	const dialog = await screen.findByRole("dialog");
	return {
		dialog,
		confirm: () =>
			fireEvent.click(within(dialog).getByRole("button", { name: "Delete example" })),
	};
}

beforeEach(() => {
	cleanup();
	useToastStore.setState({ toasts: [] });
	getRequest
		.mockReset()
		.mockResolvedValue({ id: "req_1", collectionId: "col_1", name: "List pets" });
	listRequestExamples.mockReset().mockResolvedValue([SAVED, IMPORTED]);
	listCollections.mockReset().mockResolvedValue([{ id: "col_1", name: "Pets", parentId: null }]);
	deleteRequestExample.mockReset().mockResolvedValue(undefined);
	restoreTrashEntry.mockReset().mockResolvedValue({
		id: "exa_saved",
		kind: "example",
		name: "Happy path",
		deletedAt: 1,
		collections: 0,
		requests: 0,
		restored: true,
		reparentedToRoot: false,
	});
});

describe("deleting a saved example", () => {
	it("says the Trash can give it back, not that it can't be undone", async () => {
		renderPanel();
		const { dialog } = await deleteExample("Happy path");

		expect(dialog).toHaveTextContent("You can restore it from Trash.");
		expect(dialog.textContent).not.toMatch(/can't be undone|cannot be undone/);
		expect(dialog.textContent).not.toMatch(/re-importing the document/);
	});

	it("says where it went, and the Undo restores it and refetches the list", async () => {
		renderPanel();
		const { confirm } = await deleteExample("Happy path");
		// The list the delete's own invalidation refetches: the row is gone.
		listRequestExamples.mockResolvedValue([IMPORTED]);
		confirm();

		await waitFor(() =>
			expect(deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_saved")
		);
		await waitFor(() => expect(trashToast()).toBeDefined());
		expect(trashToast()).toMatchObject({
			message: 'Moved "Happy path" to the Trash',
			variant: "info",
			action: { label: "Undo", altText: "Undo deleting the example Happy path" },
		});
		await waitFor(() => expect(screen.queryByText("Happy path")).toBeNull());

		// The restore brings the row back; the panel only learns that by refetching.
		listRequestExamples.mockResolvedValue([SAVED, IMPORTED]);
		const before = listRequestExamples.mock.calls.length;
		trashToast()?.action?.onClick();

		await waitFor(() => expect(restoreTrashEntry).toHaveBeenCalledWith("exa_saved"));
		await waitFor(() => expect(listRequestExamples.mock.calls.length).toBeGreaterThan(before));
		expect(await screen.findByText("Happy path")).toBeTruthy();
	});

	it("shows the engine's refusal when the Undo can't restore it", async () => {
		// The 409 a restore answers when the request is gone or already holds the
		// most examples it may.
		restoreTrashEntry.mockRejectedValue(
			new Error("This request already holds the maximum of 100 examples. Delete one first.")
		);
		renderPanel();
		const { confirm } = await deleteExample("Happy path");
		confirm();
		await waitFor(() => expect(trashToast()).toBeDefined());

		trashToast()?.action?.onClick();

		await waitFor(() =>
			expect(
				useToastStore
					.getState()
					.toasts.some(
						(t) =>
							t.variant === "error" &&
							t.message ===
								'Couldn\'t restore "Happy path" - This request already holds the maximum of 100 examples. Delete one first.'
					)
			).toBe(true)
		);
	});

	it("raises no Trash toast when the delete itself fails", async () => {
		deleteRequestExample.mockRejectedValue(new Error("Example not found"));
		renderPanel();
		const { dialog, confirm } = await deleteExample("Happy path");
		confirm();

		expect(await within(dialog).findByText(/Couldn.t delete the example/i)).toBeTruthy();
		expect(trashToast()).toBeUndefined();
	});
});

describe("deleting an imported example", () => {
	it("keeps the spec-sync wording and does not mention the Trash", async () => {
		renderPanel();
		const { dialog } = await deleteExample("From the spec");

		expect(dialog).toHaveTextContent(
			"Syncing this collection with its spec won't bring it back"
		);
		expect(dialog).toHaveTextContent("re-importing the document will");
		expect(dialog.textContent).not.toMatch(/restore it from Trash/);
	});

	it("offers no Undo: it is a tombstone, not a Trash entry", async () => {
		renderPanel();
		const { confirm } = await deleteExample("From the spec");
		confirm();

		await waitFor(() =>
			expect(deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_imported")
		);
		// The dialog closing is the delete having landed.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
