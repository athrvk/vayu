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
import type { EngineRecovery } from "@/types/domain";

interface EngineState {
	// Engine Connection
	isEngineConnected: boolean;
	engineError: string | null;

	/**
	 * What the engine's startup did about a database it could not open (issue
	 * #922), as reported by `GET /health`.
	 *
	 * `null` is the ordinary case - a clean start sends no `recovery` node at
	 * all. A value is read by `RecoveryBanner`, which is the only thing that
	 * tells the user their data was restored or deleted; the engine log is
	 * otherwise the whole record.
	 */
	recovery: EngineRecovery | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Connection actions
	setEngineConnected: (connected: boolean) => void;
	setEngineError: (error: string | null) => void;
	setEngineRecovery: (recovery: EngineRecovery | null) => void;

	// Restart actions
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;
}

export const useEngineStore = create<EngineState>()((set) => ({
	// Initial state
	isEngineConnected: false,
	engineError: null,
	recovery: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	// Connection actions
	setEngineConnected: (connected) => set({ isEngineConnected: connected }),
	setEngineError: (error) => set({ engineError: error }),
	setEngineRecovery: (recovery) => set({ recovery }),

	// Restart actions
	addRestartRequiredKey: (key) =>
		set((state) => ({
			pendingRestart: true,
			restartRequiredKeys: state.restartRequiredKeys.includes(key)
				? state.restartRequiredKeys
				: [...state.restartRequiredKeys, key],
		})),

	clearRestartRequired: () => set({ pendingRestart: false, restartRequiredKeys: [] }),
}));
