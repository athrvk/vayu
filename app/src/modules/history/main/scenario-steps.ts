/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The step list of a scenario run, as data.
 *
 * A collection run reaches the renderer twice over and the two sources do not
 * carry the same thing:
 *
 * - **Live**, one `step` SSE event per step execution
 *   (`build_step_payload`, engine/src/core/scenario_runner.cpp) - identity,
 *   outcome, status code and latency, and no exchange.
 * - **Stored**, one `results` row per step execution, reaching the app as
 *   `RunReport.results[]` with the design-mode trace plus the step identity
 *   `stamp_step_identity` writes onto it. That row is what the response pane
 *   restores from.
 *
 * Both collapse to {@link ScenarioStepRow} here so the view renders one list
 * and not two. Everything in this file is pure: the merge, the ordering and
 * the counts are the parts worth pinning, and none of them need a DOM.
 */

import type { ResponseValidation, RunReport, ScenarioStepEvent, StepOutcome } from "@/types";
import type { RunResultSample } from "@/modules/request-builder/utils/restore-response";

/** How many step executions ended in each outcome. */
export type OutcomeCounts = Record<StepOutcome, number>;

/**
 * One step execution, whichever source it came from.
 *
 * `result` is what separates the two: a live row has none, so the response
 * pane for that row is simply absent until the run ends and its stored row
 * arrives. A row is never invented to fill the gap.
 */
export interface ScenarioStepRow {
	/** 0-based pass over the plan. */
	iteration: number;
	/** 0-based position within the plan, stable for the run. */
	stepIndex: number;
	/** `requests.name` - what `setNextRequest` targets, and what the row shows. */
	name: string;
	outcome: StepOutcome;
	/** `0` when the step never reached a server. */
	statusCode: number;
	latencyMs: number;
	/**
	 * Which `data` row this iteration bound, absent for a run without a data
	 * set. Both sources carry it, so a row does not gain a number when its
	 * stored copy arrives.
	 */
	dataRowIndex?: number;
	/**
	 * What the contract says about this step's response (issue #681), on a row
	 * that has no stored result yet.
	 *
	 * **The live half only.** A stored row's verdict is read back through
	 * `responseFromRunResult`, the same funnel its response comes from, so
	 * there is one reader of `trace.validation` rather than a second copy here
	 * that would not receive its fixes. `ScenarioStepCard` takes whichever of
	 * the two the row has; they are the same object, because the engine stores
	 * the one it published.
	 *
	 * Absent for a step of an unbound collection and for one that sent nothing;
	 * absent is never rendered as "checked and fine".
	 */
	validation?: ResponseValidation;
	/** The stored result, present only on a row read back from the report. */
	result?: RunResultSample;
}

/**
 * A step execution's identity within its run.
 *
 * `(iteration, stepIndex)` and not the arrival order: the SSE ring replays
 * from `Last-Event-ID` on reconnect, so a client that resumed mid-run receives
 * events it has already rendered. Keying on identity makes a replay idempotent
 * where appending would double every row it re-saw.
 */
export function stepKey(step: { iteration: number; stepIndex: number }): string {
	return `${step.iteration}:${step.stepIndex}`;
}

/** Plan order: every step of iteration 0, then every step of iteration 1. */
function byPlanOrder(a: ScenarioStepRow, b: ScenarioStepRow): number {
	return a.iteration - b.iteration || a.stepIndex - b.stepIndex;
}

/**
 * Fold a `step` event into the live list.
 *
 * Returns the same array reference when nothing changed, so a replayed event
 * cannot force a re-render of a list it did not alter. A later event for a key
 * already present replaces it rather than being dropped: the engine sends one
 * event per step execution, so a second one for the same key can only be a
 * replay of that execution, and the newer copy is the one to trust.
 */
export function appendStepEvent(
	steps: readonly ScenarioStepRow[],
	event: ScenarioStepEvent
): ScenarioStepRow[] {
	const key = stepKey(event);
	const existing = steps.findIndex((s) => stepKey(s) === key);
	const row: ScenarioStepRow = { ...event };

	if (existing !== -1) {
		const current = steps[existing];
		if (
			current.outcome === row.outcome &&
			current.statusCode === row.statusCode &&
			current.latencyMs === row.latencyMs &&
			current.name === row.name
		) {
			return steps as ScenarioStepRow[];
		}
		const next = [...steps];
		next[existing] = row;
		return next;
	}

	// Sorted on insert rather than on render: events arrive in plan order in the
	// ordinary case, so this is an append, and a gap-resume that lands one out of
	// order still shows the sequence the run executed.
	return [...steps, row].sort(byPlanOrder);
}

/**
 * The step identity the engine stamps onto a stored trace, when the row carries
 * one. A `results` row without it is not a scenario step - a report fetched for
 * a load run, or a row written before the runner existed - and is skipped
 * rather than rendered as step 0 of iteration 0.
 */
function stepRowFromResult(result: RunResultSample): ScenarioStepRow | null {
	const trace = result.trace;
	if (!trace || typeof trace.stepIndex !== "number" || typeof trace.iteration !== "number") {
		return null;
	}
	return {
		iteration: trace.iteration,
		stepIndex: trace.stepIndex,
		dataRowIndex: trace.dataRowIndex,
		name: trace.stepName ?? `Step ${trace.stepIndex + 1}`,
		// An unstamped row predates the outcome and cannot be called passed -
		// "errored" is the honest reading of "this step ran and said nothing".
		outcome: trace.outcome ?? "errored",
		statusCode: result.statusCode ?? 0,
		latencyMs: result.latencyMs ?? 0,
		result,
	};
}

/** Every stored step of a scenario run's report, in plan order. */
export function stepRowsFromReport(report: RunReport | undefined): ScenarioStepRow[] {
	if (!report?.results) return [];
	const rows: ScenarioStepRow[] = [];
	for (const result of report.results) {
		const row = stepRowFromResult(result);
		if (row) rows.push(row);
	}
	return rows.sort(byPlanOrder);
}

/**
 * Count the four outcomes.
 *
 * `skipped` is its own number and is never folded into `passed`. A step the
 * runner skipped did not assert anything, and reporting it as a pass is the
 * false-pass class the run summary exists to avoid.
 */
export function countOutcomes(steps: readonly ScenarioStepRow[]): OutcomeCounts {
	const counts: OutcomeCounts = { passed: 0, failed: 0, skipped: 0, errored: 0 };
	for (const step of steps) {
		// A row whose outcome the engine did not name must not silently land in
		// one of the four buckets - `stepRowFromResult` has already decided what
		// an unstamped row counts as.
		if (step.outcome in counts) counts[step.outcome] += 1;
	}
	return counts;
}

/**
 * What the report says the run's own store thinned away, or `null` when it
 * dropped nothing (or is too old to say).
 *
 * The disclosure exists because `results[]` otherwise reads as the whole run:
 * `stepsExecuted` is what the sequence did and `stepsStored` is what survived
 * `maxScenarioStoredSteps`. Failures are kept first, so what is missing is
 * always successes - which is worth stating rather than leaving a reader to
 * infer from two numbers that do not match.
 */
export interface ThinningDisclosure {
	stepsExecuted: number;
	stepsStored: number;
	stepsDropped: number;
}

export function thinningDisclosure(report: RunReport | undefined): ThinningDisclosure | null {
	const scenario = report?.scenario;
	if (!scenario || scenario.stepsDropped <= 0) return null;
	return {
		stepsExecuted: scenario.stepsExecuted,
		stepsStored: scenario.stepsStored,
		stepsDropped: scenario.stepsDropped,
	};
}
