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
 * A sidebar rename writes the shared save status by hand - it registers no save
 * context, so `runSave`'s rule never covered it - and the Dock renders that one
 * status for the whole app. Renaming a folder while the open request holds an
 * unsaved edit therefore said "Saved": true of the rename, false of the editor
 * (#1385).
 *
 * The rename itself is unchanged, and these cases say so: the status it
 * publishes is the only thing that moved, and the failure it reports is not.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import { useTreeCrud } from "./useTreeCrud";
import type { Collection, Request } from "@/types";

const updateCollection = vi.fn();
const updateRequest = vi.fn();

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: updateCollection, isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: updateRequest, isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const collections = [{ id: "c-1", name: "Acme", order: 0 }] as Collection[];
const requests = [
	{ id: "r-1", collectionId: "c-1", name: "List users", method: "GET", order: 0 },
] as Request[];
const requestsByCollection = new Map([["c-1", requests]]);

function renderCrud() {
	return renderHook(() =>
		useTreeCrud({
			collections,
			rootCollections: collections,
			selectedCollectionId: null,
			requestsByCollection,
			getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
		})
	);
}

/** The open request tab, mid-edit: registered, dirty, and nothing to do with the tree. */
function registerDirtyRequestContext() {
	useSaveStore.getState().registerContext({
		id: "request-r-open",
		name: "Request",
		save: () => Promise.resolve(),
		hasPendingChanges: true,
	});
}

describe("collection tree rename and the shared save status", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
		updateCollection.mockResolvedValue(undefined);
		updateRequest.mockResolvedValue(undefined);
	});

	it("does not report 'Saved' for a collection rename while an editor is dirty", async () => {
		registerDirtyRequestContext();
		const { result } = renderCrud();

		act(() => result.current.rows.onRenameChange("Acme Corp"));
		await act(async () => {
			await result.current.rows.onRenameSubmit("c-1");
		});

		expect(updateCollection).toHaveBeenCalledWith({ id: "c-1", name: "Acme Corp" });
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("does not report 'Saved' for a request rename while an editor is dirty", async () => {
		registerDirtyRequestContext();
		const { result } = renderCrud();

		act(() => result.current.rows.onRequestRenameChange("List accounts"));
		await act(async () => {
			await result.current.rows.onRequestRenameSubmit("r-1");
		});

		expect(updateRequest).toHaveBeenCalledWith({ id: "r-1", name: "List accounts" });
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("still reports 'Saved' for a rename with nothing else unsaved", async () => {
		const { result } = renderCrud();

		act(() => result.current.rows.onRenameChange("Acme Corp"));
		await act(async () => {
			await result.current.rows.onRenameSubmit("c-1");
		});

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("still reports a failed rename through failSave, dirty editor or not", async () => {
		registerDirtyRequestContext();
		updateRequest.mockRejectedValue(new Error("Request name already taken"));
		const { result } = renderCrud();

		act(() => result.current.rows.onRequestRenameChange("List accounts"));
		await act(async () => {
			await result.current.rows.onRequestRenameSubmit("r-1");
		});

		expect(useSaveStore.getState().status).toBe("error");
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(useToastStore.getState().toasts[0]).toMatchObject({
			message: "Request name already taken",
			variant: "error",
		});
	});
});
