/**
 * Settings Store
 *
 * Manages settings UI state:
 * - Selected category for the sidebar
 * - Category-based filtering
 * - Restart required tracking
 */

import { create } from "zustand";
import type { SettingsCategory } from "@/types";

interface SettingsState {
	// Selected category in sidebar
	selectedCategory: SettingsCategory | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Actions
	setSelectedCategory: (category: SettingsCategory | null) => void;
	setPendingRestart: (pending: boolean, keys?: string[]) => void;
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
	selectedCategory: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	setSelectedCategory: (category) => set({ selectedCategory: category }),
	
	setPendingRestart: (pending, keys = []) => 
		set({ pendingRestart: pending, restartRequiredKeys: keys }),
	
	addRestartRequiredKey: (key) => 
		set((state) => ({
			pendingRestart: true,
			restartRequiredKeys: state.restartRequiredKeys.includes(key)
				? state.restartRequiredKeys
				: [...state.restartRequiredKeys, key],
		})),
	
	clearRestartRequired: () => 
		set({ pendingRestart: false, restartRequiredKeys: [] }),
}));
