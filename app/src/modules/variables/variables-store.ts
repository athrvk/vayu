/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** The Variables UI state: the category selected in the tree. */

import { create } from "zustand";

export type VariableCategory =
	| { type: "globals" }
	| { type: "collection"; collectionId: string }
	| { type: "environment"; environmentId: string };

interface VariablesUIState {
	selectedCategory: VariableCategory | null;

	setSelectedCategory: (category: VariableCategory | null) => void;
	reset: () => void;
}

export const useVariablesStore = create<VariablesUIState>((set) => ({
	selectedCategory: null,

	setSelectedCategory: (category) => set({ selectedCategory: category }),

	reset: () =>
		set({
			selectedCategory: null,
		}),
}));
