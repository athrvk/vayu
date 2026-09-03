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
 * - `starting` - no poll has succeeded since the engine now coming up began
 *   coming up, and it is still inside the budget the main process gives a cold
 *   one. Says nothing is wrong yet.
 * - `connected` - a poll answered `ok`.
 * - `unreachable` - a poll failed after that budget was spent, or an engine that
 *   had answered stopped answering with no start in flight. This is the state
 *   that owes the user a reason, and `engineError` carries it.
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

	/**
	 * When the engine that is currently coming up began coming up, or `null` when
	 * none is - the evidence a failed poll is classified against.
	 *
	 * It is a window rather than a "has ever connected" flag because a cold start
	 * is not only the app's first (issue #1227). `useEngineRestart` kills the
	 * running engine and spawns a fresh one that repeats the whole startup
	 * housekeeping the budget exists for, with the port down for all of it; a
	 * flag would call that silence a failure, on the evidence of an engine that
	 * no longer exists.
	 *
	 * Opened by whoever knows an engine is starting: the health poll on mount,
	 * which is when the main process spawns the first one, and the restart path,
	 * which spawns the next. Closed by the poll an engine answers, and by a
	 * restart the main process reports as failed - after which nothing is coming
	 * up and a silent port owes the user its reason again.
	 *
	 * A window nobody closes is spent rather than cleared: an engine that simply
	 * never arrives leaves its opening time here, expired. So this is not a "is
	 * something starting" flag and must not be read as one - only
	 * `engineStatusAfterFailedPoll` interprets it, and an expired timestamp and a
	 * `null` mean the same thing to it. Clearing it on expiry would need a writer
	 * watching a clock nothing else watches, to say what the timestamp already
	 * says.
	 *
	 * Kept here rather than in `useHealthQuery`'s refs, where it lived until
	 * #1227, because the restart path has to reach it. Deliberately evidence and
	 * not a status: the poll stays the only thing that classifies.
	 */
	engineStartWindow: number | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Connection actions
	setEngineStatus: (status: EngineStatus) => void;
	setEngineError: (error: string | null) => void;
	setEngineRecovery: (recovery: EngineRecovery | null) => void;
	openEngineStartWindow: (openedAt: number) => void;
	closeEngineStartWindow: () => void;

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
	// Closed until the health poll mounts and opens it. Nothing can have polled
	// before that, and a window left open here would be one no engine is inside.
	engineStartWindow: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	// Connection actions
	setEngineStatus: (status) => set({ engineStatus: status }),
	setEngineError: (error) => set({ engineError: error }),
	setEngineRecovery: (recovery) => set({ recovery }),
	openEngineStartWindow: (openedAt) => set({ engineStartWindow: openedAt }),
	closeEngineStartWindow: () => set({ engineStartWindow: null }),

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
