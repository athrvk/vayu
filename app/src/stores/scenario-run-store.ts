/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Scenario Run State Store (live collection-run steps)
 *
 * The live half of a scenario run tab. `ScenarioRunService` pushes each `step`
 * SSE event in here and `ScenarioRunView` reads it, so the stream survives
 * navigating away from the tab and back - the same split, for the same reason,
 * as `LoadTestService` and `dashboard-store`.
 *
 * It holds **one** run: a scenario is sequential, and the engine runs one at a
 * time from this app. Starting a second one replaces the first rather than
 * accumulating, so a stale run's steps can never be read as the current one's.
 *
 * Once a run reaches a terminal status its stored `results` rows are the
 * complete record and the view reads those instead - what lives here is only
 * ever what has arrived so far.
 */

import { create } from "zustand";
import type { ScenarioStepEvent } from "@/types";
import { appendStepEvent, type ScenarioStepRow } from "@/modules/history/main/scenario-steps";

interface ScenarioRunState {
	/** The run being streamed, or null when nothing is. */
	runId: string | null;
	/** Steps reported so far, in plan order. */
	steps: ScenarioStepRow[];
	/** True between `startRun` and the stream closing. */
	isStreaming: boolean;
	/** A transport failure on the stream; cleared by the next `startRun`. */
	error: string | null;

	/** Begin a run: clears any previous run's steps, then starts streaming. */
	startRun: (runId: string) => void;
	addStep: (step: ScenarioStepEvent) => void;
	setStreaming: (streaming: boolean) => void;
	setError: (error: string | null) => void;
}

export const useScenarioRunStore = create<ScenarioRunState>((set) => ({
	runId: null,
	steps: [],
	isStreaming: false,
	error: null,

	startRun: (runId) => set({ runId, steps: [], isStreaming: true, error: null }),

	/*
	 * Ignoring the identity of the run is not an option here: the stream is
	 * replayable, so a step from a run that has been replaced can still arrive
	 * on a socket that has not finished closing. It belongs to nothing on
	 * screen, so it is dropped.
	 */
	addStep: (step) =>
		set((state) => (state.runId ? { steps: appendStepEvent(state.steps, step) } : state)),

	setStreaming: (isStreaming) => set({ isStreaming }),
	setError: (error) => set({ error }),
}));
