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
 * - Category-based filtering
 * - Restart required tracking
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SettingsCategory } from "@/types";

interface SettingsState {
	// Selected category in sidebar
	selectedCategory: SettingsCategory | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Global default for the hard cap on concurrent in-flight requests.
	// null = auto (engine derives a per-strategy default). Persisted across sessions.
	maxInFlight: number | null;

	// Actions
	setSelectedCategory: (category: SettingsCategory | null) => void;
	setPendingRestart: (pending: boolean, keys?: string[]) => void;
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;
	setMaxInFlight: (value: number | null) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			selectedCategory: null,
			pendingRestart: false,
			restartRequiredKeys: [],
			maxInFlight: null,

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

			clearRestartRequired: () => set({ pendingRestart: false, restartRequiredKeys: [] }),

			setMaxInFlight: (value) => set({ maxInFlight: value }),
		}),
		{
			name: "settings-ui-store",
			// Only persist the global load-test default; UI/restart state is transient.
			partialize: (state) => ({ maxInFlight: state.maxInFlight }),
		}
	)
);
