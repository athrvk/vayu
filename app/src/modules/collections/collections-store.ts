/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Collections UI State Store
// Server state (collections, requests) is now managed by TanStack Query

import { create } from "zustand";

interface CollectionsUIState {
	// UI-only state
	expandedCollectionIds: Set<string>;

	// Actions
	toggleCollectionExpanded: (collectionId: string) => void;
	/**
	 * Expand one collection, idempotently.
	 *
	 * The tree used to hand-roll `if (!expanded.has(id)) toggle(id)` at three
	 * sites while this sat here with no callers - a toggle guarded by a read of
	 * the set it toggles, which is this action with an extra dependency on
	 * `expandedCollectionIds` bolted on. That dependency is why the ⋯ menu's
	 * actions had to be rebuilt on every expand.
	 */
	expandCollection: (collectionId: string) => void;
	expandCollections: (collectionIds: string[]) => void;
}

export const useCollectionsStore = create<CollectionsUIState>((set) => ({
	expandedCollectionIds: new Set<string>(),

	toggleCollectionExpanded: (collectionId) =>
		set((state) => {
			const newExpanded = new Set(state.expandedCollectionIds);
			if (newExpanded.has(collectionId)) {
				newExpanded.delete(collectionId);
			} else {
				newExpanded.add(collectionId);
			}
			return { expandedCollectionIds: newExpanded };
		}),

	expandCollection: (collectionId) =>
		set((state) => {
			// Same skip as `expandCollections`: expanding what is already expanded
			// must not produce a new Set, or every caller re-renders the tree.
			if (state.expandedCollectionIds.has(collectionId)) return state;
			const newExpanded = new Set(state.expandedCollectionIds);
			newExpanded.add(collectionId);
			return { expandedCollectionIds: newExpanded };
		}),

	expandCollections: (collectionIds) =>
		set((state) => {
			// Skip the update (and re-render) when every id is already expanded
			if (collectionIds.every((id) => state.expandedCollectionIds.has(id))) {
				return state;
			}
			const newExpanded = new Set(state.expandedCollectionIds);
			for (const id of collectionIds) newExpanded.add(id);
			return { expandedCollectionIds: newExpanded };
		}),
}));
