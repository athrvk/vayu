
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variables UI State Store
 *
 * Manages the Variables panel UI state including:
 * - Selected category (globals, collection, environment)
 * - Active environment selection
 * - Editing state
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type VariableCategory =
	| { type: "globals" }
	| { type: "collection"; collectionId: string }
	| { type: "environment"; environmentId: string };

interface VariablesUIState {
	// Currently selected category in the tree
	selectedCategory: VariableCategory | null;

	// Active environment for variable resolution (used in requests)
	activeEnvironmentId: string | null;

	// Active collection context (for collection variables in requests)
	activeCollectionId: string | null;

	// Editing state
	isEditing: boolean;

	// Actions
	selectCategory: (category: VariableCategory | null) => void;
	setSelectedCategory: (category: VariableCategory | null) => void; // Alias
	setActiveEnvironment: (environmentId: string | null) => void;
	setActiveEnvironmentId: (environmentId: string | null) => void; // Alias
	setActiveCollection: (collectionId: string | null) => void;
	setEditing: (editing: boolean) => void;
	reset: () => void;
}

export const useVariablesStore = create<VariablesUIState>()(
	persist(
		(set) => ({
			selectedCategory: null,
			activeEnvironmentId: null,
			activeCollectionId: null,
			isEditing: false,

			selectCategory: (category) => set({ selectedCategory: category }),

			setSelectedCategory: (category) => set({ selectedCategory: category }),

			setActiveEnvironment: (environmentId) => set({ activeEnvironmentId: environmentId }),

			setActiveEnvironmentId: (environmentId) => set({ activeEnvironmentId: environmentId }),

			setActiveCollection: (collectionId) => set({ activeCollectionId: collectionId }),

			setEditing: (editing) => set({ isEditing: editing }),

			reset: () =>
				set({
					selectedCategory: null,
					activeEnvironmentId: null,
					activeCollectionId: null,
					isEditing: false,
				}),
		}),
		{
			name: "variables-ui-store",
			partialize: (state) => ({
				// Persist active selections
				activeEnvironmentId: state.activeEnvironmentId,
				activeCollectionId: state.activeCollectionId,
			}),
		}
	)
);
