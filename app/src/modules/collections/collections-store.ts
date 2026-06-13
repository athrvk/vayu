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
	expandCollection: (collectionId: string) => void;
	expandCollections: (collectionIds: string[]) => void;
	collapseCollection: (collectionId: string) => void;
	reset: () => void;
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

	collapseCollection: (collectionId) =>
		set((state) => {
			const newExpanded = new Set(state.expandedCollectionIds);
			newExpanded.delete(collectionId);
			return { expandedCollectionIds: newExpanded };
		}),

	reset: () =>
		set({
			expandedCollectionIds: new Set<string>(),
		}),
}));
