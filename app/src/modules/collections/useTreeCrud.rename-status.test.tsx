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
 * A sidebar rename registers no save context, so it reports on the Dock under
 * an id of its own. Renaming a folder while the open request holds an unsaved
 * edit used to say "Saved": true of the rename, false of the editor (#1385).
 * The Dock is derived from every id's report now (#3350), so the editor's
 * `pending` outranks the rename's success, and a failed rename - which puts the
 * stored name back - is a toast rather than a "Not saved" describing no edit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import { useTreeCrud } from "./useTreeCrud";
import type { Collection, RequestSummary } from "@/types";

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
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const collections = [{ id: "c-1", name: "Acme", order: 0 }] as Collection[];
const requests = [
	{ id: "r-1", collectionId: "c-1", name: "List users", method: "GET", order: 0 },
] as RequestSummary[];
const requestsByCollection = new Map([["c-1", requests]]);

function renderCrud() {
	const client = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(
		() =>
			useTreeCrud({
				collections,
				requestsByCollection,
				getRequestsByCollection: (id: string) => requestsByCollection.get(id) ?? [],
				revealEntity: vi.fn(),
			}),
		{ wrapper }
	);
}

/** The open request tab, mid-edit: it reports its unsent edit under its own id. */
function openRequestHoldsAnEdit() {
	useSaveStore.getState().reportPending("request-r-open");
}

describe("what a collection tree rename leaves on the Dock", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSaveStoreForTests();
		useToastStore.setState({ toasts: [] });
		updateCollection.mockResolvedValue(undefined);
		updateRequest.mockResolvedValue(undefined);
	});

	it.each([
		{
			kind: "collection",
			submit: "onRenameSubmit",
			update: updateCollection,
			id: "c-1",
			name: "Acme Corp",
		},
		{
			kind: "request",
			submit: "onRequestRenameSubmit",
			update: updateRequest,
			id: "r-1",
			name: "List accounts",
		},
	] as const)(
		"does not report 'Saved' for a $kind rename while an editor is dirty",
		async ({ submit, update, id, name }) => {
			openRequestHoldsAnEdit();
			const { result } = renderCrud();

			await act(async () => {
				await result.current.handlers[submit](id, name);
			});

			expect(update).toHaveBeenCalledWith({ id, name });
			expect(useSaveStore.getState().status).toBe("pending");
		}
	);

	it("still reports 'Saved' for a rename with nothing else unsaved", async () => {
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onRenameSubmit("c-1", "Acme Corp");
		});

		expect(useSaveStore.getState().status).toBe("saved");
	});

	/*
	 * Mutation check: drop `writeRename`'s `discard` and the Dock stays on
	 * "Saving…"; report the failure through `reportFailed` and it says "Not
	 * saved". Either reds the status assertion.
	 */
	it("toasts a failed rename once and leaves the editor's report standing", async () => {
		openRequestHoldsAnEdit();
		updateRequest.mockRejectedValue(new Error("Request name already taken"));
		const { result } = renderCrud();

		await act(async () => {
			await result.current.handlers.onRequestRenameSubmit("r-1", "List accounts");
		});

		expect(useSaveStore.getState().status).toBe("pending");
		expect(useSaveStore.getState().unsaved.has("rename-request-r-1")).toBe(false);
		expect(useToastStore.getState().toasts).toHaveLength(1);
		expect(useToastStore.getState().toasts[0]).toMatchObject({
			message: "Couldn't rename the request - Request name already taken",
			variant: "error",
		});
	});
});
