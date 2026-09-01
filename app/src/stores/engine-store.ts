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

/**
 * Where the engine is, as the renderer's own health poll sees it.
 *
 * Three values rather than a boolean because since #1144 the window paints
 * alongside the engine instead of after it, so "not answering" is an ordinary
 * launch condition as well as a crash. One flag made both wear the crash's
 * wording and its error affordance, from first paint, on every launch.
 *
 * - `starting` - no poll has ever succeeded, and the engine is still inside the
 *   budget the main process gives a cold one. Says nothing is wrong yet.
 * - `connected` - a poll answered `ok`.
 * - `unreachable` - a poll failed after that budget was spent, or an engine that
 *   had answered before stopped answering. This is the state that owes the user
 *   a reason, and `engineError` carries it.
 */
export type EngineStatus = "starting" | "connected" | "unreachable";

interface EngineState {
	// Engine Connection
	engineStatus: EngineStatus;

	/**
	 * Why the engine is `unreachable`, as the transport reported it.
	 *
	 * `null` in every other state, `starting` included: a launch whose engine has
	 * simply not answered yet has no failure to report, and a string written
	 * there would be one the Dock deliberately does not render.
	 */
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
	setEngineStatus: (status: EngineStatus) => void;
	setEngineError: (error: string | null) => void;
	setEngineRecovery: (recovery: EngineRecovery | null) => void;

	// Restart actions
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;
}

export const useEngineStore = create<EngineState>()((set) => ({
	// Initial state. `starting`, not `unreachable`: this value is what the Dock
	// renders on first paint, before any poll has been answered or refused.
	engineStatus: "starting",
	engineError: null,
	recovery: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	// Connection actions
	setEngineStatus: (status) => set({ engineStatus: status }),
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
