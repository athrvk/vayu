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
 * Renaming a row in the tree, and what it is allowed to send.
 *
 * Two defects lived here. The rename field submits on Enter *and* on blur, and
 * both handlers cleared their rename state only after awaiting the mutation - so
 * the field was still mounted when Enter's PUT went out, and the blur that
 * followed sent a second one. The collection path additionally had no
 * unchanged-name check, so opening a rename and clicking away PUT the name it
 * already had.
 *
 * The third case is the status timer: both paths armed a bare
 * `setTimeout(() => setStatus("idle"))`, which fires no matter what happened in
 * between - clearing a failure another surface had published to the Dock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useSaveStore, useToastStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";
import { TIMING } from "@/config/timing";

const updateCollection = vi.fn();
const updateRequest = vi.fn();

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
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: updateCollection, isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: updateRequest, isPending: false }),
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

/** F2 on a focused row is the keyboard path into the same rename handlers. */
function startRename(selector: string) {
	const row = document.querySelector<HTMLElement>(selector)!;
	row.focus();
	fireEvent.keyDown(row, { key: "F2" });
	const field = document.querySelector<HTMLInputElement>(`${selector} input`);
	expect(field).not.toBeNull();
	return field!;
}

beforeEach(() => {
	updateCollection.mockReset().mockResolvedValue(collection);
	updateRequest.mockReset().mockResolvedValue(request);
	useSaveStore.setState({ status: "idle" });
	useToastStore.setState({ toasts: [] });
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
});

describe("renaming a collection", () => {
	it("sends nothing when the name is unchanged", async () => {
		renderTree();
		const field = startRename('[data-collection-id="c1"]');

		fireEvent.blur(field);

		await waitFor(() =>
			expect(document.querySelector('[data-collection-id="c1"] input')).toBeNull()
		);
		expect(updateCollection).not.toHaveBeenCalled();
		// Nothing was saved, so nothing may claim it was.
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("sends nothing when the name is only whitespace", async () => {
		renderTree();
		const field = startRename('[data-collection-id="c1"]');

		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.keyDown(field, { key: "Enter" });

		await waitFor(() =>
			expect(document.querySelector('[data-collection-id="c1"] input')).toBeNull()
		);
		expect(updateCollection).not.toHaveBeenCalled();
	});

	it("sends exactly one PUT when Enter is followed by the blur it causes", async () => {
		renderTree();
		const field = startRename('[data-collection-id="c1"]');

		fireEvent.change(field, { target: { value: "Payments" } });
		fireEvent.keyDown(field, { key: "Enter" });
		// The real field blurs as it unmounts; firing it explicitly is the
		// worst case, and the one that used to send a second PUT.
		fireEvent.blur(field);

		await waitFor(() => expect(updateCollection).toHaveBeenCalledTimes(1));
		expect(updateCollection).toHaveBeenCalledWith({ id: "c1", name: "Payments" });
	});

	it("reports a failed rename", async () => {
		updateCollection.mockRejectedValue(new Error("database is locked"));
		renderTree();
		const field = startRename('[data-collection-id="c1"]');

		fireEvent.change(field, { target: { value: "Payments" } });
		fireEvent.keyDown(field, { key: "Enter" });

		await waitFor(() => expect(useSaveStore.getState().status).toBe("error"));
		expect(useToastStore.getState().toasts[0]?.message).toMatch(/database is locked/i);
	});
});

describe("renaming a request", () => {
	it("sends nothing when the name is unchanged", async () => {
		renderTree();
		const field = startRename('[data-request-id="r1"]');

		fireEvent.blur(field);

		await waitFor(() =>
			expect(document.querySelector('[data-request-id="r1"] input')).toBeNull()
		);
		expect(updateRequest).not.toHaveBeenCalled();
	});

	it("sends exactly one PUT when Enter is followed by the blur it causes", async () => {
		renderTree();
		const field = startRename('[data-request-id="r1"]');

		fireEvent.change(field, { target: { value: "List users" } });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.blur(field);

		await waitFor(() => expect(updateRequest).toHaveBeenCalledTimes(1));
		expect(updateRequest).toHaveBeenCalledWith({ id: "r1", name: "List users" });
	});
});

describe("the status timer a rename arms", () => {
	beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
	afterEach(() => vi.useRealTimers());

	it("returns the Dock to idle when nothing else has happened", async () => {
		renderTree();
		const field = startRename('[data-collection-id="c1"]');
		fireEvent.change(field, { target: { value: "Payments" } });
		fireEvent.keyDown(field, { key: "Enter" });

		await waitFor(() => expect(useSaveStore.getState().status).toBe("saved"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		renderTree();
		const field = startRename('[data-collection-id="c1"]');
		fireEvent.change(field, { target: { value: "Payments" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(useSaveStore.getState().status).toBe("saved"));

		// Anything else failing before the timer fires: an unrelated delete, an
		// editor's autosave. The Dock is now showing that error.
		act(() => useSaveStore.getState().failSave("delete failed"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		// The rename's timer used to clear it and leave the Dock saying nothing at
		// all, next to a toast about a failure.
		expect(useSaveStore.getState().status).toBe("error");
	});
});
