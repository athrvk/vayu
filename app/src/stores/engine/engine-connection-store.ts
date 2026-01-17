
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Engine Connection State Store
// Handles engine connection status and errors

import { create } from "zustand";

interface EngineConnectionState {
	// Engine Connection
	isEngineConnected: boolean;
	engineError: string | null;

	// Actions
	setEngineConnected: (connected: boolean) => void;
	setEngineError: (error: string | null) => void;
	reset: () => void;
}

export const useEngineConnectionStore = create<EngineConnectionState>((set) => ({
	// Initial state
	isEngineConnected: false,
	engineError: null,

	// Actions
	setEngineConnected: (connected) => set({ isEngineConnected: connected }),
	setEngineError: (error) => set({ engineError: error }),
	reset: () => set({ isEngineConnected: false, engineError: null }),
}));
