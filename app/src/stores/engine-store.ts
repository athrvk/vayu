/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine's connection status and errors, and the restart-required tracking (pending restart,
 * the config keys that need it).
 */

import { create } from "zustand";
import type { EngineRecovery } from "@/types/domain";

/**
 * Where the engine is, as the renderer's own health poll sees it. Three values, not a boolean: the
 * window paints alongside the engine, not after it (#1144), so "not answering" is an ordinary
 * launch condition as well as a crash, and one flag gave every launch the crash's wording and error
 * affordance from first paint.
 *
 * - `starting`: no poll has succeeded since the engine now coming up began coming up, and it is
 *   still inside the budget the main process gives a cold one. Nothing is wrong yet.
 * - `connected`: a poll answered `ok`.
 * - `unreachable`: a poll failed after that budget was spent, or an engine that had answered
 *   stopped answering with no start in flight. This state owes the user a reason, and `engineError`
 *   carries it.
 */
export type EngineStatus = "starting" | "connected" | "unreachable";

/**
 * How the main process's engine left without being asked to (#3336): the facts
 * its sidecar recorded, as `engine:lifecycle` carries them. `error` is set for a
 * child that failed to run rather than one that exited.
 */
export interface EngineCrash {
	code: number | null;
	signal: string | null;
	stderrTail: string[];
	error: string | null;
}

/** The kind of run a crash ended: the dashboard's load test, or a streamed collection run. */
export type CrashEndedRun = "load" | "collection";

interface EngineState {
	// Engine Connection
	engineStatus: EngineStatus;

	/**
	 * Why the engine is `unreachable`, as the transport reported it. `null` in every other state,
	 * `starting` included: an engine that has not answered yet has no failure to report, and a
	 * string there would be one the Dock deliberately does not render.
	 */
	engineError: string | null;

	/**
	 * Why the main process has no engine to start, when no crashed child explains it: another
	 * program holding every port the engine may use (#2118), or a start that failed before it had a
	 * child (#3610). `null` otherwise.
	 *
	 * Apart from `engineError` because it is the main process's own report, not the transport's: it
	 * does not wait out the startup budget (the engine is known not to be coming), and its presence
	 * makes the Dock offer Retry. Written by the health poll, cleared by the poll an engine
	 * answers.
	 */
	engineStartFailure: string | null;

	/**
	 * How the engine's process left, when the sidecar reports it left on its own (#3336); `null`
	 * while it runs or once a start is under way again.
	 *
	 * A fact about the process, not a status: `engineStatus` stays the health poll's verdict, and
	 * this explains it, offers the Dock's Restart, and keeps a stale `connected`, and a `starting`
	 * no restart is behind, off screen (`selectKnownEngineStatus`). Written by `useEngineLifecycle`
	 * from each pushed transition, so it clears when the sidecar moves on, not when a restart is
	 * asked for.
	 */
	engineCrash: EngineCrash | null;

	/**
	 * The crash in `engineCrash` was pushed after the health poll's last verdict (#3493), so a
	 * `connected` there describes the process that left. Set by `setEngineCrash` with a crash,
	 * cleared by every `setEngineStatus` (only the poll calls it): a verdict after the push, the
	 * restarted engine's `connected` included, is the newer word. `engineCrash` itself stays until
	 * the sidecar reports `ready`, which can trail that verdict, so it cannot decide.
	 */
	engineCrashAheadOfPoll: boolean;

	/**
	 * The runs the crash in `engineCrash` ended (#3605), for the engine-lost notification's one
	 * sentence that says so.
	 *
	 * Written with the crash in the one `setEngineCrash` call, because it is a fact about that
	 * crash: the dashboard's `engineStopped` phase and the scenario store's `endedByEngineStop`
	 * outlive it (until the run's report lands or the next run starts, and the dashboard may not be
	 * mounted to settle it from another tab), so a later engine loss would find them still raised.
	 * Replaced by the next crash, emptied by `setEngineCrash(null)` and by `consumeCrashEndedRuns`,
	 * which the notification calls so one crash is not narrated twice.
	 */
	crashEndedRuns: readonly CrashEndedRun[];

	/**
	 * A restart is in flight. One flag for every surface that offers the action
	 * (the Dock and the Settings banner), so a second click or the other surface
	 * does not start another; see `useEngineRestart`.
	 */
	engineRestarting: boolean;

	/**
	 * What the engine's startup did about a database it could not open (#922), as `GET /health`
	 * reports it. `null` is the ordinary case: a clean start sends no `recovery` node. A value is
	 * read by `RecoveryBanner`, the only thing that tells the user their data was restored or
	 * deleted; otherwise the engine log is the whole record.
	 */
	recovery: EngineRecovery | null;

	/**
	 * The `workers` setting's effective value, as the last successful health poll reported it
	 * (#1508): the configured count, or the detected core count when nothing overrides it. `null`
	 * before the first poll answers, as `recovery` is.
	 */
	workers: number | null;

	/**
	 * When the engine now coming up began coming up, or `null` when none is: the evidence a failed
	 * poll is classified against.
	 *
	 * A window, not a "has ever connected" flag, because a cold start is not only the app's first
	 * (#1227): `useEngineRestart` kills the running engine and spawns a fresh one that repeats the
	 * whole startup housekeeping the budget exists for, with the port down for all of it, and a
	 * flag would call that silence a failure on the evidence of an engine that no longer exists.
	 *
	 * Opened by whoever knows an engine is starting: the health poll on mount (when the main
	 * process spawns the first) and the restart path (which spawns the next). Closed by the poll an
	 * engine answers, and by a restart the main process reports as failed, after which nothing is
	 * coming up and a silent port owes the user its reason again.
	 *
	 * A window nobody closes is spent, not cleared: an engine that never arrives leaves its opening
	 * time here, expired. So this is not an "is something starting" flag and must not be read as
	 * one; only `engineStatusAfterFailedPoll` interprets it, and to it an expired timestamp and
	 * `null` mean the same. Clearing it on expiry would need a writer watching a clock nothing else
	 * watches.
	 *
	 * Kept here rather than in `useHealthQuery`'s refs because the restart path has to reach it.
	 * Evidence, deliberately, not a status: the poll stays the only thing that classifies.
	 */
	engineStartWindow: number | null;

	// Restart required notification
	pendingRestart: boolean;
	restartRequiredKeys: string[]; // Keys of configs that were changed and require restart

	// Connection actions
	setEngineStatus: (status: EngineStatus) => void;
	setEngineError: (error: string | null) => void;
	setEngineStartFailure: (failure: string | null) => void;
	setEngineCrash: (crash: EngineCrash | null, endedRuns?: readonly CrashEndedRun[]) => void;
	consumeCrashEndedRuns: () => void;
	setEngineRestarting: (restarting: boolean) => void;
	setEngineRecovery: (recovery: EngineRecovery | null) => void;
	setWorkers: (workers: number | null) => void;
	openEngineStartWindow: (openedAt: number) => void;
	closeEngineStartWindow: () => void;

	// Restart actions
	addRestartRequiredKey: (key: string) => void;
	clearRestartRequired: () => void;
}

/**
 * The engine's status as the app shows it: the health poll's verdict, except where a crash the
 * sidecar reported says more.
 *
 * - A `connected` the poll gave before the crash was pushed (#3493). The override lasts until the
 *   poll's next verdict, whatever it says, but a strip reading "Engine connected" beside a Restart
 *   button, or a drawer of green services the dead process took with it, is wrong for all of it.
 * - A `starting` with no restart in flight (#3610). A failed poll inside the startup grace is
 *   `starting` for up to `ENGINE_STARTUP_GRACE_MS`, and an engine that exited at spawn is not
 *   coming. Keyed on the crash itself, not on `engineCrashAheadOfPoll`, because every failed poll
 *   rewrites the status and clears that flag. With a restart in flight `starting` passes through:
 *   the restart is the crash's successor.
 *
 * Derived on read, never written back: the poll stays the one writer of `engineStatus`, and the
 * crash push only asks it to look again (`useEngineLifecycle`).
 */
export function selectKnownEngineStatus(
	s: Pick<
		EngineState,
		"engineStatus" | "engineCrash" | "engineCrashAheadOfPoll" | "engineRestarting"
	>
): EngineStatus {
	if (s.engineCrash === null) return s.engineStatus;
	if (s.engineStatus === "connected" && s.engineCrashAheadOfPoll) return "unreachable";
	if (s.engineStatus === "starting" && !s.engineRestarting) return "unreachable";
	return s.engineStatus;
}

/**
 * Whether the Dock shows Restart (after a crash) or Retry (after a start failure). Read by the Dock
 * and by copy that points at it, so a tip never names a button the Dock is not drawing (#3493).
 */
export function selectEngineRestartOffered(
	s: Pick<EngineState, "engineStartFailure" | "engineCrash">
): boolean {
	return Boolean(s.engineStartFailure) || Boolean(s.engineCrash);
}

export const useEngineStore = create<EngineState>()((set) => ({
	// Initial state. `starting`, not `unreachable`: this value is what the Dock
	// renders on first paint, before any poll has been answered or refused.
	engineStatus: "starting",
	engineError: null,
	engineStartFailure: null,
	engineCrash: null,
	engineCrashAheadOfPoll: false,
	crashEndedRuns: [],
	engineRestarting: false,
	recovery: null,
	workers: null,
	// Closed until the health poll mounts and opens it. Nothing can have polled
	// before that, and a window left open here would be one no engine is inside.
	engineStartWindow: null,
	pendingRestart: false,
	restartRequiredKeys: [],

	// Connection actions
	setEngineStatus: (status) => set({ engineStatus: status, engineCrashAheadOfPoll: false }),
	setEngineError: (error) => set({ engineError: error }),
	setEngineStartFailure: (failure) => set({ engineStartFailure: failure }),
	setEngineCrash: (crash, endedRuns = []) =>
		set({
			engineCrash: crash,
			engineCrashAheadOfPoll: crash !== null,
			crashEndedRuns: crash === null ? [] : endedRuns,
		}),
	consumeCrashEndedRuns: () => set({ crashEndedRuns: [] }),
	setEngineRestarting: (restarting) => set({ engineRestarting: restarting }),
	setEngineRecovery: (recovery) => set({ recovery }),
	setWorkers: (workers) => set({ workers }),
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
