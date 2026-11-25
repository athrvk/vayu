/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { focusTreeRow } from "./tree-focus";
import { entityRowKey, folderRowKey, requestRowKey } from "./tree-rows";
import { walkAncestors } from "./tree-utils";
import type { TreeRowWindow } from "./CollectionTreeRows";
import type { TreeEntity } from "./drop-position";
import type { Collection, RequestSummary } from "@/types";

export interface RevealActiveSelectionOptions {
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	collections: Collection[];
	requestsByCollection: Map<string, RequestSummary[]>;
	/** Read only as a scroll trigger: a row appears when its ancestors expand. */
	expandedCollectionIds: Set<string>;
	expandCollections: (collectionIds: string[]) => void;
}

export interface RevealActiveSelection {
	/**
	 * Put a row that just moved back where the user can see it and keep going from: ancestors
	 * expanded, scrolled into view, and holding the tree's tab stop so a repeated Alt+Arrow lands
	 * on the same row. Not routed through the selection reveal: a move does not change the
	 * selection, so nothing in that effect's dependencies fires, and forcing it would re-expand
	 * ancestors the user has since collapsed.
	 */
	revealEntity: (entity: TreeEntity) => void;
}

/**
 * Keep the row the active tab points at both rendered and on screen. Two effects that cannot share
 * a ref: the scroll can only run a render *after* the reveal, once the expanded ancestors have put
 * the row in the list. Each records the selection it last acted on, so it fires once per selection,
 * not per render. Both scrolls go through the tree's window (`rowWindow`), never the row element: a
 * row in a long list may not be mounted until the drawer is scrolled to it (#2543), and the window
 * scrolls the drawer body alone, where `scrollIntoView` would move every scrollable ancestor too
 * (#1612).
 */
export function useRevealActiveSelection(
	treeRef: RefObject<HTMLDivElement | null>,
	rowWindow: RefObject<TreeRowWindow | null>,
	{
		selectedCollectionId,
		selectedRequestId,
		collections,
		requestsByCollection,
		expandedCollectionIds,
		expandCollections,
	}: RevealActiveSelectionOptions
): RevealActiveSelection {
	const revealedSelectionRef = useRef<string | null>(null);
	const scrolledSelectionRef = useRef<string | null>(null);
	/** The key of the row a move put somewhere, until it has been revealed. */
	const movedRowRef = useRef<string | null>(null);

	/*
	 * Reveal whatever the active tab points at: expand its ancestor folders so the row renders,
	 * then (in the effect below) scroll it into view. Guarded by a ref so it fires once per
	 * selection: it lists `requestsByCollection` and `collections` and the tree re-renders on any
	 * expand-state change, so an unguarded run would re-expand a collapsed collection holding the
	 * selected request in the same frame, a dead chevron with every ancestor of the active tab
	 * pinned open. Once per selection *change*, so switching tabs away and back reveals again.
	 */
	useEffect(() => {
		const selectionId = selectedCollectionId ?? selectedRequestId;
		if (!selectionId) {
			// Settings, Variables, no tab at all: re-selecting the entity later is a
			// fresh selection and must reveal again.
			revealedSelectionRef.current = null;
			scrolledSelectionRef.current = null;
			return;
		}
		if (revealedSelectionRef.current === selectionId) return;

		// A collection reveals itself; a request reveals the collection holding it.
		let target: string | undefined;
		if (selectedCollectionId) {
			target = selectedCollectionId;
		} else {
			for (const [collectionId, reqs] of requestsByCollection) {
				if (reqs.some((r) => r.id === selectedRequestId)) {
					target = collectionId;
					break;
				}
			}
		}
		// The owning collection's requests may not have arrived yet. Leave the ref
		// unset so this reveals once they do, rather than counting as done.
		if (!target) return;

		// walkAncestors, not a local loop: this walk is unbounded on a `parentId`
		// cycle, which hangs the renderer inside an effect (see tree-utils).
		const ancestorChain = walkAncestors(target, collections).map((c) => c.id);
		revealedSelectionRef.current = selectionId;
		expandCollections(ancestorChain);
	}, [
		selectedRequestId,
		selectedCollectionId,
		requestsByCollection,
		collections,
		expandCollections,
	]);

	/*
	 * Once the selected row exists (after ancestors expand), scroll it into view, once per
	 * selection: otherwise every expand or collapse elsewhere in the tree would yank the view back.
	 */
	useEffect(() => {
		const id = selectedCollectionId ?? selectedRequestId;
		if (!id || scrolledSelectionRef.current === id) return;
		const key = selectedCollectionId ? folderRowKey(id) : requestRowKey(id);
		if (rowWindow.current?.revealRow(key)) scrolledSelectionRef.current = id;
	}, [
		rowWindow,
		selectedRequestId,
		selectedCollectionId,
		expandedCollectionIds,
		requestsByCollection,
	]);

	const revealEntity = useCallback(
		(entity: TreeEntity) => {
			const ownerId = entity.kind === "collection" ? entity.parentId : entity.collectionId;
			if (ownerId) {
				expandCollections(walkAncestors(ownerId, collections).map((c) => c.id));
			}
			movedRowRef.current = entityRowKey(entity);
		},
		[collections, expandCollections]
	);

	/*
	 * The other half of `revealEntity`, run after *every* render on purpose: the awaited row may
	 * not exist yet (a move into a collapsed folder renders it only once the expand lands), and no
	 * dependency names "the moved row is now in the list". Clearing a ref, not state, keeps this
	 * out of the render loop it observes.
	 */
	useEffect(() => {
		const pending = movedRowRef.current;
		const tree = treeRef.current;
		if (!pending || !tree) return;
		// The roving tabindex follows: the moved row is where the user is working, and a tab stop
		// left on the row it displaced makes the next Alt+Arrow move something else (see
		// useRovingTreeFocus).
		if (rowWindow.current?.revealRow(pending, (row) => focusTreeRow(tree, row))) {
			movedRowRef.current = null;
		}
	});

	return { revealEntity };
}
