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
import type { ScenarioRunPlanEvent, ScenarioStepEvent } from "@/types";
import type { TerminalRunStatus } from "@/lib/run-status";
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
	/**
	 * Bumped whenever {@link steps} changed by anything other than growing at
	 * its end - a run starting, a replay replacing a row in place, a gap-resume
	 * splicing one in. Constant while the list only appends.
	 *
	 * Read by `useFilteredSteps` (issue #1205), which keeps the rows a chip or
	 * the search box matched and extends them with the batch that just arrived
	 * rather than re-filtering the whole run per commit. Every commit hands the
	 * view a new array, so "the same list, longer" and "a different list" are
	 * indistinguishable from the rows alone; this is the fold telling it, in one
	 * number rather than a comparison of the two lists.
	 *
	 * Monotone, and never reset: a reader that missed a commit - React may
	 * render once for two of them - sees the number move and rebuilds, where a
	 * value that could return to one it had already seen would let a stale
	 * prefix through.
	 */
	appendEpoch: number;
	/**
	 * The size the engine resolved for the run, from the `plan` frame that opens
	 * its stream (#1398); null until one arrives, which for an older engine, or
	 * a client attached past the frame's eviction from the tick ring, is for the
	 * whole run. Read by `ScenarioRunView`'s live "Iteration k of N" line.
	 */
	plan: ScenarioRunPlanEvent | null;
	/** True between `startRun` and the stream closing or failing. */
	isStreaming: boolean;
	/** A transport failure on the stream; cleared by the next `startRun`. */
	error: string | null;
	/**
	 * How the run ended, once this window knows: the engine's completion frame,
	 * or for a stream that closed without one, the stored report's status.
	 * Null while it runs and for a stream that dropped mid-run, whose run has
	 * not ended. Read by `RunAnnouncer`; the run tab reads the stored record.
	 */
	endedAs: TerminalRunStatus | null;

	/*
	 * `startRun` is the one action that replaces the held run. Every other
	 * writer names the run it speaks for and is dropped for any other, as in
	 * `execution-events-store`: the stream is replayable, so a frame from a
	 * replaced run can still arrive on a socket that has not finished closing,
	 * and a release for one run must not lower a successor's flag.
	 */
	/** Begin a run: clears any previous run's steps, then starts streaming. */
	startRun: (runId: string) => void;
	addSteps: (runId: string, steps: readonly ScenarioStepEvent[]) => void;
	setPlan: (runId: string, plan: ScenarioRunPlanEvent) => void;
	setStreaming: (runId: string, streaming: boolean) => void;
	/**
	 * The stream failed: records why and lowers {@link isStreaming} in one
	 * write. The run itself keeps executing on the engine, and the view reads
	 * its stored status for that once the stream says nothing more.
	 */
	streamLost: (runId: string, message: string) => void;
	/** The run ended as `status`: records it and lowers {@link isStreaming} in one write. */
	runEnded: (runId: string, status: TerminalRunStatus) => void;
}

export const useScenarioRunStore = create<ScenarioRunState>((set) => ({
	runId: null,
	steps: [],
	summary: emptyStepSummary(),
	appendEpoch: 0,
	plan: null,
	isStreaming: false,
	error: null,
	endedAs: null,

	// An emptied list is the sharpest case of "not the list you were reading",
	// so the epoch moves here too - without it, a second run's first batches
	// would look like the first run's list getting longer.
	startRun: (runId) =>
		set((state) => ({
			runId,
			steps: [],
			summary: emptyStepSummary(),
			appendEpoch: state.appendEpoch + 1,
			plan: null,
			isStreaming: true,
			error: null,
			endedAs: null,
		})),

	// A batch that changed nothing - every event in it a replay of a row
	// already held - returns the state object itself, so zustand notifies nobody.
	addSteps: (runId, steps) =>
		set((state) => {
			if (state.runId !== runId || steps.length === 0) return state;
			const { fold, appendedOnly } = foldStepEvents(
				{ steps: state.steps, summary: state.summary },
				steps
			);
			return fold.steps === state.steps
				? state
				: {
						steps: fold.steps,
						summary: fold.summary,
						appendEpoch: appendedOnly ? state.appendEpoch : state.appendEpoch + 1,
					};
		}),

	// A frame that outlives the run it opened must not size the next one.
	setPlan: (runId, plan) => set((state) => (state.runId === runId ? { plan } : state)),

	setStreaming: (runId, isStreaming) =>
		set((state) => (state.runId === runId ? { isStreaming } : state)),

	streamLost: (runId, error) =>
		set((state) => (state.runId === runId ? { error, isStreaming: false } : state)),

	runEnded: (runId, endedAs) =>
		set((state) => (state.runId === runId ? { endedAs, isStreaming: false } : state)),
}));
