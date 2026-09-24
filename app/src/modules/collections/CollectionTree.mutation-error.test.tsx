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
 * A failed create or delete used to resolve to nothing at all: `mutateAsync`
 * was called bare, so a rejection became an unhandled promise and the row
 * stayed exactly where it was with no explanation. That reads as "my click
 * didn't register", which invites the user to try again against a backend
 * that just refused.
 *
 * The report is a plain error toast that names what was attempted, and never
 * the save-state machine: `failSave` parks the Dock on "Not saved", and a
 * failed delete or create is not an unsaved edit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useSaveStore, useToastStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const deleteRequest = vi.fn();
const createCollection = vi.fn();

const collection = { id: "c1", name: "Acme API", order: 0 };
const request = { id: "r1", collectionId: "c1", name: "Get users", method: "GET", order: 0 };

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: [collection],
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({
		requestsByCollection: new Map([["c1", [request]]]),
	}),
	useCreateCollectionMutation: () => ({ mutateAsync: createCollection, isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: deleteRequest, isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	deleteRequest.mockReset();
	createCollection.mockReset();
	useSaveStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
});

describe("CollectionTree when a mutation rejects", () => {
	it("reports a failed delete instead of just un-dimming the row", async () => {
		deleteRequest.mockRejectedValue(new Error("database is locked"));
		renderTree();

		// Delete on a focused row is the keyboard path into the same handler
		// the ⋯ menu uses (see useRovingTreeFocus), and a request delete runs
		// at once, with an undo toast rather than a dialog.
		const row = document.querySelector<HTMLElement>('[data-request-id="r1"]')!;
		row.focus();
		fireEvent.keyDown(row, { key: "Delete" });

		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({
				variant: "error",
				message: "Couldn't delete the request - database is locked",
			})
		);
		expect(useSaveStore.getState().status).toBe("idle");
		expect(useSaveStore.getState().lastErrorMessage).toBeNull();
	});

	it("reports a failed create and keeps the typed name to retry with", async () => {
		createCollection.mockRejectedValue(new Error("disk full"));
		renderTree();

		fireEvent.click(screen.getByRole("button", { name: /add collection/i }));
		const field = screen.getByPlaceholderText(/Collection name/i);
		fireEvent.change(field, { target: { value: "Payments" } });
		fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));

		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({
				variant: "error",
				message: "Couldn't create the collection - disk full",
			})
		);
		expect(useSaveStore.getState().status).toBe("idle");
		expect(screen.getByPlaceholderText(/Collection name/i)).toHaveValue("Payments");
	});

	it("leaves the save status alone when the delete succeeds", async () => {
		deleteRequest.mockResolvedValue(undefined);
		renderTree();

		const row = document.querySelector<HTMLElement>('[data-request-id="r1"]')!;
		row.focus();
		fireEvent.keyDown(row, { key: "Delete" });

		await waitFor(() => expect(deleteRequest).toHaveBeenCalledWith("r1"));
		expect(useSaveStore.getState().status).not.toBe("error");
	});
});
