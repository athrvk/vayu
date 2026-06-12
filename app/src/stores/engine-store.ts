/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Engine Store
 *
 * Merged store managing:
 * - Engine connection status and errors
 * - Restart required tracking (pending restart + required config keys)
 */

import { create } from "zustand";

interface EngineState {
	// Engine Connection
	isEngineConnected: boolean;
	engineError: string | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Connection actions
	setEngineConnected: (connected: boolean) => void;
	setEngineError: (error: string | null) => void;

	// Restart actions
	setPendingRestart: (pending: boolean, keys?: string[]) => void;
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;

	// Reset
	reset: () => void;
}

export const useEngineStore = create<EngineState>()((set) => ({
	// Initial state
	isEngineConnected: false,
	engineError: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	// Connection actions
	setEngineConnected: (connected) => set({ isEngineConnected: connected }),
	setEngineError: (error) => set({ engineError: error }),

	// Restart actions
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

	// Reset all
	reset: () =>
		set({
			isEngineConnected: false,
			engineError: null,
			pendingRestart: false,
			restartRequiredKeys: [],
		}),
}));
