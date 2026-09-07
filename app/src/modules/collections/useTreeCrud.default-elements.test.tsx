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
 * The two script tabs this feature replaced were always present, so a fresh
 * collection or request always had somewhere to type a pre-request or test
 * script. `elements: []` loses that visible slot behind an "Add element"
 * menu a new user has no reason to know about yet. Every creation path -
 * the sidebar's New Collection/Folder/Request, and the command palette's
 * "New Request" via `useNewRequest` - seeds a `script.pre`/`script.post`
 * pair instead, empty and enabled, so the Elements tab looks the way the
 * old two tabs did on a brand-new entity.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTreeCrud } from "./useTreeCrud";
import type { Collection } from "@/types";
import type { ElementDef } from "@/types";

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

/** Every seeded pair looks like this, regardless of which path created it. */
function expectScriptPair(elements: unknown) {
	const list = elements as ElementDef[];
	expect(list).toHaveLength(2);
	expect(list[0]).toMatchObject({ kind: "script.pre", enabled: true, config: { script: "" } });
	expect(list[1]).toMatchObject({ kind: "script.post", enabled: true, config: { script: "" } });
	// Distinct ids - two elements of the same kind pair would otherwise collide.
	expect(list[0].id).not.toBe(list[1].id);
}

beforeEach(() => {
	createCollection.mockReset();
	createRequest.mockReset();
	createCollection.mockResolvedValue({ id: "c-new" });
	createRequest.mockResolvedValue({ id: "r-new", collectionId: "c-1" });
});

describe("new-entity creation seeds a script.pre/script.post pair", () => {
	it("a top-level collection", async () => {
		const { result } = renderCrud();

		act(() => result.current.panel.setNewCollectionName("New Collection"));
		await act(async () => result.current.panel.createCollection());

		expect(createCollection).toHaveBeenCalledTimes(1);
		expectScriptPair(createCollection.mock.calls[0][0].elements);
	});

	it("a subfolder", async () => {
		const { result } = renderCrud();

		act(() => result.current.rows.onSubCollectionNameChange("New Folder"));
		await act(async () => result.current.rows.onCreateSubfolder("c-1"));

		expect(createCollection).toHaveBeenCalledTimes(1);
		const sent = createCollection.mock.calls[0][0];
		expect(sent.parentId).toBe("c-1");
		expectScriptPair(sent.elements);
	});

	it("a request added from a collection's row menu", async () => {
		const { result } = renderCrud();

		const addRequest = result.current.rows
			.getCollectionActions(collections[0])
			.find((a) => a.label === "Add Request");
		await act(async () => addRequest?.onSelect());

		expect(createRequest).toHaveBeenCalledTimes(1);
		expectScriptPair(createRequest.mock.calls[0][0].elements);
	});
});
