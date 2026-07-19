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

	// Actions
	setSelectedCategory: (category: SettingsCategory | null) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
	// Default to a real category so the settings tab opens with content
	selectedCategory: "appearance",

	setSelectedCategory: (category) => set({ selectedCategory: category }),
}));
