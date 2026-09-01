/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Scenario Run State Store (live collection-run steps)
 *
 * The live half of a scenario run tab. `ScenarioRunService` pushes the `step`
 * SSE events in here in batches and `ScenarioRunView` reads them, so the stream
 * survives navigating away from the tab and back - the same split, for the same
 * reason, as `LoadTestService` and `dashboard-store`.
 *
 * **Batches, not events** (issue #1153). The service buffers on the live-refresh
 * cadence and commits what it collected in one `set()`, so a run whose steps
 * come back in a millisecond costs the renderer what a slow one does. The
 * summary beside the rows is folded in the same pass rather than recounted by
 * the view, which is what keeps the cost of a commit off the length of the run -
 * the `dashboard-store` aggregate stance, for the same reason.
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
import {
	emptyStepSummary,
	foldStepEvents,
	type ScenarioStepRow,
	type StepListSummary,
} from "@/modules/history/main/scenario-steps";

interface ScenarioRunState {
	/** The run being streamed, or null when nothing is. */
	runId: string | null;
	/** Steps reported so far, in plan order. */
	steps: ScenarioStepRow[];
	/**
	 * What the header says about {@link steps}, folded as they arrive rather
	 * than recounted per commit. Read by `ScenarioRunView` for the four count
	 * chips and the two whole-list questions the rows answer - which is the
	 * only thing that makes storing it worth the field.
	 */
	summary: StepListSummary;
	/** True between `startRun` and the stream closing. */
	isStreaming: boolean;
	/** A transport failure on the stream; cleared by the next `startRun`. */
	error: string | null;

	/** Begin a run: clears any previous run's steps, then starts streaming. */
	startRun: (runId: string) => void;
	addSteps: (steps: readonly ScenarioStepEvent[]) => void;
	setStreaming: (streaming: boolean) => void;
	setError: (error: string | null) => void;
}

export const useScenarioRunStore = create<ScenarioRunState>((set) => ({
	runId: null,
	steps: [],
	summary: emptyStepSummary(),
	isStreaming: false,
	error: null,

	startRun: (runId) =>
		set({
			runId,
			steps: [],
			summary: emptyStepSummary(),
			isStreaming: true,
			error: null,
		}),

	/*
	 * Ignoring the identity of the run is not an option here: the stream is
	 * replayable, so a step from a run that has been replaced can still arrive
	 * on a socket that has not finished closing. It belongs to nothing on
	 * screen, so it is dropped.
	 *
	 * A batch that changed nothing - every event in it a replay of a row already
	 * held - returns the state object itself, so zustand notifies nobody.
	 */
	addSteps: (steps) =>
		set((state) => {
			if (!state.runId || steps.length === 0) return state;
			const next = foldStepEvents({ steps: state.steps, summary: state.summary }, steps);
			return next.steps === state.steps
				? state
				: { steps: next.steps, summary: next.summary };
		}),

	setStreaming: (isStreaming) => set({ isStreaming }),
	setError: (error) => set({ error }),
}));
