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

import type {
	ResponseValidation,
	RunReport,
	ScenarioStepEvent,
	StepOutcome,
	StepTestTally,
	TestResult,
} from "@/types";
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
	 * The stored request this step executed, so a step that failed has a way
	 * back to the request that sent it (issue #730).
	 *
	 * **Both sources carry it** (issue #831): `stamp_step_identity` writes it
	 * onto the stored trace and `build_step_payload` sends it on the live
	 * frame, so a step does not gain its link when the run ends - one id is
	 * constant-size, which is what lets the frame carry it where the assertion
	 * list stays on the stored row.
	 *
	 * Absent for a step whose plan entry names no stored request, and for a row
	 * stored before the runner stamped one; the card offers no link rather than
	 * one to an empty id.
	 */
	requestId?: string;
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
	/**
	 * How many of this step's assertions held (issue #724), on a row that has no
	 * stored result yet.
	 *
	 * **The live half only**, for the reason the verdict above is: a stored
	 * row's assertions come back as the list itself, through the funnel its
	 * response comes from, and `ScenarioStepCard` tallies that list rather than
	 * reading a second copy the engine would have to keep in step.
	 */
	tests?: StepTestTally;
	/** The stored result, present only on a row read back from the report. */
	result?: RunResultSample;
}

/**
 * What the reader has narrowed the step list to (issues #730, #832).
 *
 * Two controls, one predicate. Narrowing by outcome and by name at once is the
 * useful case - "the failed executions of `POST /checkout`" - and two lists
 * filtered in sequence would be the same thing said twice, with two empty
 * states to keep in step.
 */
export interface StepListFilter {
	/** The outcome chip that is pressed, or `null` for all four. */
	outcome: StepOutcome | null;
	/** What was typed in the search box; untrimmed, as the field holds it. */
	query: string;
}

/**
 * Whether a step's **name** contains `query`, case-insensitively.
 *
 * The name and nothing else. A row's URL lives in its stored trace, which a
 * live row does not have, so matching it would make the box search less while
 * a run streams than it does once the run ends - a control that quietly
 * changes what it covers is worse than one that covers one field always. What
 * it matches is stated on the field itself and in `docs/app/COMPONENTS.md`.
 */
function matchesQuery(step: ScenarioStepRow, query: string): boolean {
	return step.name.toLowerCase().includes(query);
}

/**
 * The rows to show under `filter`.
 *
 * Returns the same array reference when nothing narrows, so an untouched view
 * hands `useGrowingWindow` the total it already had rather than a new array
 * that only looks like a new list.
 */
export function filterSteps(
	steps: readonly ScenarioStepRow[],
	filter: StepListFilter
): readonly ScenarioStepRow[] {
	const query = filter.query.trim().toLowerCase();
	const { outcome } = filter;
	if (outcome === null && query === "") return steps;
	return steps.filter(
		(step) =>
			(outcome === null || step.outcome === outcome) &&
			(query === "" || matchesQuery(step, query))
	);
}

/** Why the step list is empty, when a control rather than the run emptied it. */
export interface EmptyStepListReason {
	title: string;
	description: string;
}

/**
 * The empty state for a list some control narrowed to nothing, or `null` when
 * no control is narrowing it - that case is the run's own emptiness and the
 * view answers it with the run's status, not with this.
 *
 * Which control emptied the list is the whole content of the message, because
 * the two are cleared in different places: a reader who reads "no failed steps"
 * over a list their search emptied clears the wrong one. The outcome half also
 * has to hold the thinning disclosure - the chip counts the *run* and the rows
 * are the *store's*, and a filled store drops passes - which is why an
 * outcome-shaped emptiness cannot reuse the search's wording.
 */
export function emptyStepListReason(
	filter: StepListFilter,
	thinned: ThinningDisclosure | null
): EmptyStepListReason | null {
	const query = filter.query.trim();
	const { outcome } = filter;
	if (outcome === null && query === "") return null;

	// Said wherever the chip is one of the two controls: it counts the whole
	// run, and this list is what the run's store kept.
	const chipNote = thinned
		? "This run's step store filled and dropped successes - the chip counts the whole run, this list holds what was kept."
		: "The chip above counts the whole run; these rows are what it stored.";

	if (outcome !== null && query !== "") {
		return {
			title: `No ${outcome} steps matching "${query}"`,
			description: `Two controls are narrowing this list: the ${outcome} chip and the search, which matches the step name. Clear either one to widen it. ${chipNote}`,
		};
	}
	if (outcome !== null) {
		return {
			title: `No ${outcome} steps in the stored rows`,
			description: chipNote,
		};
	}
	return {
		title: `No steps matching "${query}"`,
		description:
			"The search matches the step name. Clear it to see every step this run stored.",
	};
}

/**
 * The tally of a stored step's assertion list, or `undefined` when it made none.
 *
 * The live half arrives counted (the `step` frame carries two numbers); a
 * stored row arrives as the list, so this is where the two meet. `undefined`
 * for an empty list keeps the chip absent on a scriptless step rather than
 * claiming "0 tests passed" - and a run stored before #724 has no list at all,
 * which reads the same way rather than as a failure.
 */
export function tallyTests(results: readonly TestResult[] | undefined): StepTestTally | undefined {
	if (!results?.length) return undefined;
	let passed = 0;
	for (const test of results) {
		if (test.passed) passed += 1;
	}
	return { passed, failed: results.length - passed };
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
 * The first index of a plan-ordered list whose row does not sort before `row` -
 * where `row` belongs, and where its own earlier copy would be.
 *
 * A binary search rather than a re-sort and a scan (issue #730): the list is
 * sorted by construction, so sorting per arriving event re-establishes an
 * invariant that was never lost, and it did so on every one of a 5,000-step
 * run's events. The ordinary case is an append, which the first comparison
 * below answers; a gap-resume that lands out of order still finds its seat
 * rather than sitting at the end.
 */
function planOrderIndex(steps: readonly ScenarioStepRow[], row: ScenarioStepRow): number {
	if (steps.length === 0 || byPlanOrder(row, steps[steps.length - 1]) > 0) return steps.length;
	let low = 0;
	let high = steps.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (byPlanOrder(steps[mid], row) < 0) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * Whether a replayed event says anything its row does not already say.
 *
 * The four fields a `step` event carries that can differ between the first
 * delivery of an execution and a replay of it. Identity is not among them: two
 * rows only reach this comparison when they sort equal, which is exactly when
 * `stepKey` would match.
 */
function sameStepRow(current: ScenarioStepRow, row: ScenarioStepRow): boolean {
	return (
		current.outcome === row.outcome &&
		current.statusCode === row.statusCode &&
		current.latencyMs === row.latencyMs &&
		current.name === row.name
	);
}

/**
 * A live step list and the summary that describes it, folded together.
 *
 * They travel as one because the summary is only correct *for* these rows: the
 * fold maintains it incrementally ({@link foldStepEvents}), so a caller holding
 * one without the other holds a number nothing produced.
 */
export interface StepFold {
	steps: ScenarioStepRow[];
	summary: StepListSummary;
}

/**
 * Fold a batch of `step` events into the live list and its summary.
 *
 * **One commit per batch, one copy per batch.** The list is rebuilt once here
 * however many events the batch carries, where folding them one at a time cost
 * a full array copy each - quadratic over a run, and the reason
 * `ScenarioRunService` buffers rather than committing per event (issue #1153).
 *
 * Returns the `current` fold itself when no event changed anything, so a
 * replayed batch cannot force a re-render of a list it did not alter. A later
 * event for a key already present replaces it rather than being dropped: the
 * engine sends one event per step execution, so a second one for the same key
 * can only be a replay of that execution, and the newer copy is the one to
 * trust.
 */
export function foldStepEvents(current: StepFold, events: readonly ScenarioStepEvent[]): StepFold {
	// Null until an event actually changes something, which is what lets an
	// all-replay batch return `current` and commit nothing.
	let next: StepFold | null = null;

	for (const event of events) {
		const fold = next ?? current;
		const row: ScenarioStepRow = { ...event };
		/*
		 * One search answers both questions - "is this a replay?" and "where
		 * does a new row go?" - because plan order *is* the identity order: two
		 * rows sort equal exactly when `stepKey` would match. The scan this
		 * replaces walked the whole list per event, which on a long run is the
		 * same cost as the sort below it.
		 */
		const at = planOrderIndex(fold.steps, row);
		const replacing = at < fold.steps.length && byPlanOrder(fold.steps[at], row) === 0;
		if (replacing && sameStepRow(fold.steps[at], row)) continue;

		next ??= { steps: [...current.steps], summary: cloneStepSummary(current.summary) };

		if (replacing) {
			applyStepRow(next.summary, next.steps[at], -1);
			next.steps[at] = row;
		} else if (at === next.steps.length) {
			// Events arrive in plan order in the ordinary case, so this is an
			// append; a gap-resume that lands one out of order still finds its
			// seat below rather than sitting at the end.
			next.steps.push(row);
		} else {
			next.steps.splice(at, 0, row);
		}
		applyStepRow(next.summary, row, 1);
	}

	return next ?? current;
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
		// The one thing the trace carried that nothing read (issue #730). A row
		// written before the runner stamped it has none, and the card offers no
		// link rather than one to an empty id.
		requestId: trace.requestId,
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
 * Everything the run tab's header says about a step list.
 *
 * Held as one object because the live path maintains all three incrementally
 * ({@link foldStepEvents}) rather than scanning the list per commit. Three
 * loose fields would be three things a caller can hold half of; one is one.
 */
export interface StepListSummary {
	/**
	 * The four outcomes.
	 *
	 * `skipped` is its own number and is never folded into `passed`. A step the
	 * runner skipped did not assert anything, and reporting it as a pass is the
	 * false-pass class the run summary exists to avoid.
	 */
	counts: OutcomeCounts;
	/**
	 * How many steps are past the first pass. `> 0` means a row should say
	 * which iteration it belongs to.
	 */
	iterationSteps: number;
	/** How many steps recorded the `data` row their iteration bound. */
	dataBoundSteps: number;
}

/** The summary of a list with nothing in it. */
export function emptyStepSummary(): StepListSummary {
	return {
		counts: { passed: 0, failed: 0, skipped: 0, errored: 0 },
		iterationSteps: 0,
		dataBoundSteps: 0,
	};
}

function cloneStepSummary(summary: StepListSummary): StepListSummary {
	return {
		counts: { ...summary.counts },
		iterationSteps: summary.iterationSteps,
		dataBoundSteps: summary.dataBoundSteps,
	};
}

/**
 * Add one row to `summary`, or take one back out. Mutates: callers own the
 * object they pass.
 *
 * Every field is a count rather than a flag, and `sign` is what makes the fold
 * reversible: a replay that replaces a row takes the old one out before putting
 * the new one in. A latched boolean would be cheaper by two integers and wrong
 * the moment a replacement stopped binding a data row - a replay is compared on
 * outcome, status, latency and name, not on `dataRowIndex` - and knowing
 * whether any *other* row still bound one would mean rescanning the list, which
 * is the whole-list scan this summary exists to avoid. Counting instead means
 * the incremental summary equals {@link summarizeSteps} for any sequence of
 * events, with no assumption about what the engine does or does not replay.
 */
function applyStepRow(summary: StepListSummary, row: ScenarioStepRow, sign: 1 | -1): void {
	// A row whose outcome the engine did not name must not silently land in one
	// of the four buckets - `stepRowFromResult` has already decided what an
	// unstamped row counts as.
	if (row.outcome in summary.counts) summary.counts[row.outcome] += sign;
	if (row.iteration > 0) summary.iterationSteps += sign;
	if (row.dataRowIndex !== undefined) summary.dataBoundSteps += sign;
}

/**
 * Summarize a whole list in one pass.
 *
 * The stored path reads its summary from here - the rows arrive complete, so
 * there is nothing to fold incrementally - and it is the oracle the live
 * path's incremental summary is checked against.
 */
export function summarizeSteps(steps: readonly ScenarioStepRow[]): StepListSummary {
	const summary = emptyStepSummary();
	for (const step of steps) applyStepRow(summary, step, 1);
	return summary;
}

/**
 * The run's four outcome totals as the engine counted them, or `null` when the
 * report cannot say (a live run before its report arrives, or a sidecar older
 * than these fields).
 *
 * These are the **whole-run** counts - `report.scenario.passed/failed/...`,
 * written from every step the runner executed - not a tally of the stored rows.
 * The rows are thinned by `maxScenarioStoredSteps` and thinning drops only
 * passes, so counting the rows undercounts `passed` on any run that filled
 * its store: a 6,000-step run keeping 5,000 rows would read "4,990 passed"
 * beside a header claiming 6,000 steps. The stored-row count stays the list's
 * own disclosure line (`thinningDisclosure`); the chips read the truth here.
 *
 * All four are read defensively: an older report typed as carrying them may
 * omit one at runtime, and a partial read is worse than falling back to the
 * rows wholesale.
 */
export function outcomeCountsFromReport(report: RunReport | undefined): OutcomeCounts | null {
	const scenario = report?.scenario;
	if (!scenario) return null;
	const { passed, failed, skipped, errored } = scenario;
	if (
		typeof passed !== "number" ||
		typeof failed !== "number" ||
		typeof skipped !== "number" ||
		typeof errored !== "number"
	) {
		return null;
	}
	return { passed, failed, skipped, errored };
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
