/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What `RunAnnouncer` says when a run moves (#3498): the sentence for one
 * transition of the dashboard's load test or the streamed collection run, or
 * `null` when the move is not one worth speaking.
 *
 * Transitions only - started, then how it ended - never a figure that moves
 * while the run does: a polite region re-announces on every change, and a
 * load test's ticks arrive several times a second. A lost stream and the wait
 * for the report are not transitions either; the run is still going, or its
 * ending is about to be said. The engine's process ending under a load test
 * is one (#3605): the run ended, and nothing says how until a restarted engine
 * serves its report, so that is said then, as the run's ending.
 *
 * The verdict is the banner's (`reportOutcome`), so the spoken line and the one
 * on screen cannot disagree.
 */

import { OUTCOME_TITLE, reportOutcome } from "@/components/shared/run-outcome";
import type { TerminalRunStatus } from "@/lib/run-status";
import { spokenSymbols } from "@/lib/spoken-text";
import { stepOutcomeLine, type OutcomeCounts } from "@/modules/history/main/scenario-steps";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import { dashboardRunEnding, type DashboardPhase } from "@/stores/dashboard-store";
import type { RunReport } from "@/types";

export interface DashboardSnapshot {
	runId: string | null;
	phase: DashboardPhase;
}

export interface ScenarioSnapshot {
	runId: string | null;
	isStreaming: boolean;
	endedAs: TerminalRunStatus | null;
}

/**
 * The dashboard's phase, coarsened to what is said aloud. `unreported` is a run
 * whose stream closed and whose report could not be read: it has ended, and
 * nothing can say how. `engineStopped` is a run that ended with its engine's
 * process, and is not `running`: it must never be heard as one.
 */
type DashboardStage = "running" | "unreported" | "engineStopped" | TerminalRunStatus;

function dashboardStage(phase: DashboardPhase): DashboardStage | null {
	if (phase.phase === "idle") return null;
	const ending = dashboardRunEnding(phase);
	if (ending) return ending;
	if (phase.phase === "engineStopped") return "engineStopped";
	return phase.phase === "reportError" ? "unreported" : "running";
}

/** "Load test completed. Passed. All 3 budgets met", or just how it ended when unjudged. */
function loadTestEnded(kind: TerminalRunStatus, report: RunReport | null): string {
	const name = RUN_TYPE_NAME.load;
	// A stopped run's verdict is "Stopped before it finished", which says nothing more.
	const judgement = kind === "stopped" ? null : reportOutcome(report);
	if (!judgement) return `${name} ${kind}`;
	// A failed run's reason is the whole verdict; a completed one can still have failed.
	const verdict =
		kind === "completed"
			? `${OUTCOME_TITLE[judgement.outcome]}. ${judgement.reason}`
			: judgement.reason;
	return spokenSymbols(`${name} ${kind}. ${verdict}`);
}

export function dashboardAnnouncement(
	prev: DashboardSnapshot,
	next: DashboardSnapshot
): string | null {
	const stage = dashboardStage(next.phase);
	if (!next.runId || !stage) return null;
	const sameRun = prev.runId === next.runId;
	if (sameRun && stage === dashboardStage(prev.phase)) return null;
	// Back to running on the same run is a report Retry, not a start.
	if (stage === "running") return sameRun ? null : `${RUN_TYPE_NAME.load} started`;
	if (stage === "engineStopped") return `${RUN_TYPE_NAME.load} ended. Vayu's engine stopped`;
	if (stage === "unreported") {
		return `${RUN_TYPE_NAME.load} finished. Couldn't load the run report`;
	}
	return loadTestEnded(stage, next.phase.phase === "finished" ? next.phase.report : null);
}

/** What the scenario store holds about a run once it has ended. */
export interface ScenarioEnding {
	counts: OutcomeCounts;
	thresholdValidation: RunReport["thresholdValidation"] | null;
}

/**
 * `ended` is the store's step tally and budget block, read once the run has
 * ended; the service writes the ending and the budgets in one `runEnded`, so a
 * missed budget is in the one sentence rather than a second (#3539). A run
 * that started and ended between two renders is announced by its ending alone.
 */
export function scenarioAnnouncement(
	prev: ScenarioSnapshot,
	next: ScenarioSnapshot,
	ended: ScenarioEnding | null
): string | null {
	if (!next.runId) return null;
	const name = RUN_TYPE_NAME.scenario;
	const sameRun = prev.runId === next.runId;
	if (next.endedAs && ended && (!sameRun || next.endedAs !== prev.endedAs)) {
		return `${name} ${next.endedAs}. ${stepOutcomeLine(ended.counts, ended.thresholdValidation)}`;
	}
	if (!sameRun && next.isStreaming) return `${name} started`;
	return null;
}
