
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
	isSavingCollection: boolean;
	isSavingRequest: boolean;

	// Actions
	toggleCollectionExpanded: (collectionId: string) => void;
	expandCollection: (collectionId: string) => void;
	collapseCollection: (collectionId: string) => void;
	setSavingCollection: (saving: boolean) => void;
	setSavingRequest: (saving: boolean) => void;
	reset: () => void;
}

export const useCollectionsStore = create<CollectionsUIState>((set) => ({
	expandedCollectionIds: new Set<string>(),
	isSavingCollection: false,
	isSavingRequest: false,

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

	collapseCollection: (collectionId) =>
		set((state) => {
			const newExpanded = new Set(state.expandedCollectionIds);
			newExpanded.delete(collectionId);
			return { expandedCollectionIds: newExpanded };
		}),

	setSavingCollection: (saving) => set({ isSavingCollection: saving }),
	setSavingRequest: (saving) => set({ isSavingRequest: saving }),

	reset: () =>
		set({
			expandedCollectionIds: new Set<string>(),
			isSavingCollection: false,
			isSavingRequest: false,
		}),
}));
