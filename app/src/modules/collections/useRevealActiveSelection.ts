/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef, type RefObject } from "react";
import { walkAncestors } from "./tree-utils";
import type { Collection, Request } from "@/types";

export interface RevealActiveSelectionOptions {
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	collections: Collection[];
	requestsByCollection: Map<string, Request[]>;
	/** Read only as a scroll trigger: a row appears when its ancestors expand. */
	expandedCollectionIds: Set<string>;
	expandCollections: (collectionIds: string[]) => void;
}

/**
 * Keep the row the active tab points at both rendered and on screen.
 *
 * Two effects, not one, and they cannot share a ref: the scroll can only run a
 * render *after* the reveal, once the expanded ancestors have put the row in
 * the DOM. Each records the selection it last acted on so it fires once per
 * selection rather than once per render.
 */
export function useRevealActiveSelection(
	treeRef: RefObject<HTMLDivElement | null>,
	{
		selectedCollectionId,
		selectedRequestId,
		collections,
		requestsByCollection,
		expandedCollectionIds,
		expandCollections,
	}: RevealActiveSelectionOptions
): void {
	const revealedSelectionRef = useRef<string | null>(null);
	const scrolledSelectionRef = useRef<string | null>(null);

	/*
	 * Reveal whatever the active tab points at: expand its ancestor folders so
	 * the row is rendered, then (in the effect below) scroll it into view.
	 *
	 * This used to handle requests only, which is why switching to a *collection*
	 * tab looked like the sidebar ignored it - a collection nested inside a
	 * collapsed parent has no row in the tree at all, so there was nothing to
	 * highlight and nothing to scroll to. `selectedCollectionId` was computed and
	 * then only used for a label and a highlight, so nothing revealed it.
	 *
	 * Settings and Variables never had the problem because they own a whole
	 * drawer view; a request did not because of this effect. A collection fell
	 * between the two.
	 *
	 * Guarded by a ref so it fires once per selection - the same discipline the
	 * scroll effect below has always had. Unguarded, it re-ran after *every*
	 * render of the tree (it lists `requestsByCollection` and `collections`, and
	 * the tree re-renders on any expand-state change), so collapsing a
	 * collection that held the selected request re-expanded it in the same
	 * frame: the chevron looked dead and every ancestor of the active tab was
	 * pinned open. Once per selection *change* means switching tabs away and
	 * back reveals again, which is the behaviour that was wanted all along.
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
	 * Once the selected row exists (after ancestors expand), scroll it into view.
	 * Guarded by a ref so it only fires once per selection - otherwise every
	 * expand/collapse elsewhere in the tree would yank the view back.
	 */
	useEffect(() => {
		const id = selectedCollectionId ?? selectedRequestId;
		if (!id || scrolledSelectionRef.current === id) return;
		const attr = selectedCollectionId ? "data-collection-id" : "data-request-id";
		const row = treeRef.current?.querySelector(`[${attr}="${CSS.escape(id)}"]`);
		if (row) {
			row.scrollIntoView({ block: "nearest" });
			scrolledSelectionRef.current = id;
		}
	}, [
		treeRef,
		selectedRequestId,
		selectedCollectionId,
		expandedCollectionIds,
		requestsByCollection,
	]);
}
