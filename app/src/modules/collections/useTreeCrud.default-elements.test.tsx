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
 * A fresh collection or request used to be created with a seeded, empty
 * `script.pre`/`script.post` pair, so the Elements tab looked the way the two
 * script columns it replaced always did. That seeding is retired (#1609): it
 * made every new collection's inherited-elements notice claim two elements
 * would run when neither did anything, and gave the engine an "empty script"
 * outcome to compose, run and report for no behaviour. Every creation path -
 * the sidebar's New Collection/Folder/Request, and the command palette's
 * "New Request" via `useNewRequest` - now sends no `elements` at all, so the
 * entity starts with the engine's own default, `[]`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTreeCrud } from "./useTreeCrud";
import type { Collection } from "@/types";

const createCollection = vi.fn();
const createRequest = vi.fn();

vi.mock("@/queries", () => ({
	useCreateCollectionMutation: () => ({ mutateAsync: createCollection, isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const collections = [{ id: "c-1", name: "Acme", order: 0 }] as Collection[];
const requestsByCollection = new Map();

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

beforeEach(() => {
	createCollection.mockReset();
	createRequest.mockReset();
	createCollection.mockResolvedValue({ id: "c-new" });
	createRequest.mockResolvedValue({ id: "r-new", collectionId: "c-1" });
});

describe("new-entity creation sends no seeded elements", () => {
	it("a top-level collection", async () => {
		const { result } = renderCrud();

		act(() => result.current.panel.setNewCollectionName("New Collection"));
		await act(async () => result.current.panel.createCollection());

		expect(createCollection).toHaveBeenCalledTimes(1);
		expect(createCollection.mock.calls[0][0]).not.toHaveProperty("elements");
	});

	it("a subfolder", async () => {
		const { result } = renderCrud();

		act(() => result.current.rows.onSubCollectionNameChange("New Folder"));
		await act(async () => result.current.rows.onCreateSubfolder("c-1"));

		expect(createCollection).toHaveBeenCalledTimes(1);
		const sent = createCollection.mock.calls[0][0];
		expect(sent.parentId).toBe("c-1");
		expect(sent).not.toHaveProperty("elements");
	});

	it("a request added from a collection's row menu", async () => {
		const { result } = renderCrud();

		const addRequest = result.current.rows
			.getCollectionActions(collections[0])
			.find((a) => a.label === "Add Request");
		await act(async () => addRequest?.onSelect());

		expect(createRequest).toHaveBeenCalledTimes(1);
		expect(createRequest.mock.calls[0][0]).not.toHaveProperty("elements");
	});
});
