/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings Store
 *
 * Manages settings UI state:
 * - Selected category for the sidebar
 */

import { create } from "zustand";
import type { SettingsCategory } from "@/types";

interface SettingsState {
	// Selected category in sidebar
	selectedCategory: SettingsCategory | null;

	/**
	 * The engine entry a search result asked for, read by `SettingsMain` to
	 * scroll that card into view and outline it. Cleared as soon as it has been
	 * shown - it is a one-shot instruction, not a selection that persists.
	 */
	highlightedKey: string | null;

	/**
	 * What the settings sidebar's search box holds.
	 *
	 * Store state rather than the tree's own `useState` because the palette's
	 * "Search settings for …" escape row hands its query over: the palette
	 * finds, the sidebar browses, and the browse surface has to open already
	 * filtered. A user still only ever types into the tree's own box.
	 */
	searchQuery: string;

	// Actions
	setSelectedCategory: (category: SettingsCategory | null, highlightedKey?: string) => void;
	clearHighlight: () => void;
	setSearchQuery: (query: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
	// Default to a real category so the settings tab opens with content
	selectedCategory: "appearance",
	highlightedKey: null,
	searchQuery: "",

	setSelectedCategory: (category, highlightedKey) =>
		set({ selectedCategory: category, highlightedKey: highlightedKey ?? null }),
	clearHighlight: () => set({ highlightedKey: null }),
	setSearchQuery: (query) => set({ searchQuery: query }),
}));
