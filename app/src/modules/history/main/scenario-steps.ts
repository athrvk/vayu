/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The step list of a scenario run, as data. A collection run reaches the renderer from two sources
 * that do not carry the same thing:
 *
 * - **Live**, one `step` SSE event per step execution (`build_step_payload`,
 *   engine/src/core/scenario_runner.cpp): identity, outcome, status code and latency, no exchange.
 * - **Stored**, one `results` row per step execution, arriving as `RunReport.results[]` with the
 *   design-mode trace plus the step identity `stamp_step_identity` writes onto it; the response
 *   pane restores from that row.
 *
 * Both collapse to {@link ScenarioStepRow} so the view renders one list, not two. Everything here
 * is pure: the merge, the ordering and the counts are worth pinning, and none needs a DOM.
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
import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import { missedBudgetsReason } from "@/components/shared/run-outcome";

/** How many step executions ended in each outcome. */
export type OutcomeCounts = Record<StepOutcome, number>;

/**
 * "41 passed, 2 failed": what the run did, not that it is over (#1358), the line its notification
 * and its spoken announcement both carry. Skipped, errored and stopped steps are named only when
 * there are any, so a clean run's line stays two numbers long and an errored run never reads as a
 * pass. A step a Stop cut short (#3397) is named stopped and is in no failure count, so a stopped
 * run does not read as failed.
 *
 * Given the stored report's budget block, a run that missed a budget says so after the counts ("12
 * passed, 0 failed. 1 of 2 budgets missed: p99", #3539): a missed budget fails the run while every
 * step passed, and the counts alone would read clean.
 */
export function stepOutcomeLine(
	counts: OutcomeCounts,
	thresholdValidation?: RunReport["thresholdValidation"] | null
): string {
	const parts = [`${counts.passed} passed`, `${counts.failed} failed`];
	if (counts.errored > 0) parts.push(`${counts.errored} errored`);
	if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
	if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
	const line = parts.join(", ");
	const missed = missedBudgetsReason(thresholdValidation);
	return missed ? `${line}. ${missed}` : line;
}

/**
 * One step execution, whichever source it came from. `result` separates the two: a live row has
 * none, so its response pane is absent until the run ends and the stored row arrives; a row is
 * never invented to fill the gap.
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
	 * Which `data` row this iteration bound; absent for a run without a data set. Both sources
	 * carry it, so a row does not gain a number when its stored copy arrives.
	 */
	dataRowIndex?: number;
	/**
	 * Plan positions the error that ended this step's iteration cost (issue
	 * #2526), on the one step that ended it. Both sources carry it, the stored
	 * copy from `trace_data`, so a row does not lose the line when the run ends.
	 */
	stepsNotRun?: number;
	/**
	 * This step's extractions that found nothing and unset their variable (#3053). Both sources
	 * carry it, on {@link stepsNotRun}'s terms.
	 */
	extractorMisses?: number;
	/**
	 * How many distinct `{{names}}` this step sent unresolved (issue #3248).
	 * Both sources carry it, on the terms {@link stepsNotRun} is carried on.
	 */
	unresolvedTokens?: number;
	/**
	 * The stored request this step executed, so a failed step has a way back to the request that
	 * sent it (#730). **Both sources carry it** (#831): `stamp_step_identity` writes it onto the
	 * stored trace and `build_step_payload` sends it on the live frame, so a step does not gain its
	 * link when the run ends; one id is constant-size, which is why the frame can carry it while
	 * the assertion list stays on the stored row.
	 *
	 * Absent for a step whose plan entry names no stored request, and for a row stored before the
	 * runner stamped one; the card then offers no link rather than one to an empty id.
	 */
	requestId?: string;
	/**
	 * What the contract says about this step's response (#681), on a row with no stored result yet.
	 * **The live half only**: a stored row's verdict is read back through `responseFromRunResult`,
	 * the funnel its response comes from, so there is one reader of `trace.validation`, not a
	 * second copy here that would miss its fixes. `ScenarioStepCard` takes whichever the row has;
	 * they are the same object, as the engine stores the one it published.
	 *
	 * Absent for a step of an unbound collection and for one that sent nothing; absent is never
	 * rendered as "checked and fine".
	 */
	validation?: ResponseValidation;
	/**
	 * How many of this step's assertions held (#724), on a row with no stored result yet. **The
	 * live half only**, for the verdict's reason: a stored row's assertions come back as the list
	 * itself, through its response's funnel, and `ScenarioStepCard` tallies that list rather than
	 * read a second copy the engine would have to keep in step.
	 */
	tests?: StepTestTally;
	/** The stored result, present only on a row read back from the report. */
	result?: RunResultSample;
}

/**
 * What the reader has narrowed the step list to (#730, #832). Two controls, one predicate: by
 * outcome and by name at once is the useful case ("the failed executions of `POST /checkout`"), and
 * two lists filtered in sequence would say it twice, with two empty states to keep in step.
 */
export interface StepListFilter {
	/** The outcome chip that is pressed, or `null` for all of them. */
	outcome: StepOutcome | null;
	/** What was typed in the search box; untrimmed, as the field holds it. */
	query: string;
}

/**
 * Whether a step's **name** contains `query`, case-insensitively. The name only: a row's URL lives
 * in its stored trace, which a live row lacks, so matching it would make the box search less while
 * a run streams than after it ends, and a control that quietly changes what it covers is worse than
 * one that always covers one field. The field itself and `docs/app/COMPONENTS/history.md` state
 * what it matches.
 */
function matchesQuery(step: ScenarioStepRow, query: string): boolean {
	return step.name.toLowerCase().includes(query);
}

/**
 * Whether either control is narrowing the list. The one place that is answered, because three
 * callers must agree: {@link filterSteps} hands the list back untouched when nothing narrows,
 * {@link emptyStepListReason} then has no control to blame, and `useFilteredSteps` has nothing to
 * maintain. A whitespace-only query narrows nothing, the half a second copy would get wrong.
 */
export function narrowsSteps(filter: StepListFilter): boolean {
	return filter.outcome !== null || filter.query.trim() !== "";
}

/**
 * The predicate `filter` describes, as a function of one row. **The one definition, which is why it
 * is exported** (#1297): a live list counts its matches and produces its window in two passes that
 * stop at different places (the count at the end of the batch, the window once it has enough rows),
 * so neither can be a call to {@link filterSteps}, which returns every match. Handing out the
 * predicate keeps that from becoming a second copy of the rule; {@link filterSteps} is this applied
 * to a whole list, and the oracle a windowed reader is checked against.
 *
 * The query is trimmed and lowercased once, here, not per row.
 */
export function stepMatcher(filter: StepListFilter): (step: ScenarioStepRow) => boolean {
	const query = filter.query.trim().toLowerCase();
	const { outcome } = filter;
	return (step) =>
		(outcome === null || step.outcome === outcome) &&
		(query === "" || matchesQuery(step, query));
}

/**
 * The rows to show under `filter`. Returns the same array when nothing narrows, so an untouched
 * view hands its window the total it had rather than a new array that only looks like a new list.
 * One predicate wherever the rows come from: {@link stepMatcher} holds it, and a live list
 * (`useFilteredSteps`, #1205, #1297) calls it directly rather than testing rows another way.
 */
export function filterSteps(
	steps: readonly ScenarioStepRow[],
	filter: StepListFilter
): readonly ScenarioStepRow[] {
	if (!narrowsSteps(filter)) return steps;
	return steps.filter(stepMatcher(filter));
}

/** Why the step list is empty, when a control rather than the run emptied it. */
export interface EmptyStepListReason {
	title: string;
	description: string;
}

/**
 * The empty state for a list a control narrowed to nothing, or `null` when none is narrowing (the
 * run's own emptiness, which the view answers with the run's status). Which control emptied the
 * list is the whole message, as the two are cleared in different places: a reader shown "no failed
 * steps" over a list their search emptied clears the wrong one. The outcome half also carries the
 * thinning disclosure (the chip counts the *run*, the rows are the *store's*, and a filled store
 * drops passes), so it cannot reuse the search's wording.
 */
export function emptyStepListReason(
	filter: StepListFilter,
	thinned: ThinningDisclosure | null
): EmptyStepListReason | null {
	if (!narrowsSteps(filter)) return null;
	const query = filter.query.trim();
	const { outcome } = filter;

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
 * The tally of a stored step's assertion list, or `undefined` when it made none. The live half
 * arrives counted (the `step` frame carries two numbers); a stored row arrives as the list, so the
 * two meet here. `undefined` for an empty list keeps the chip off a scriptless step rather than
 * claiming "0 tests passed", and a run stored before #724 has no list, which reads the same, not as
 * a failure.
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
 * A step execution's identity within its run: `(iteration, stepIndex)`, not arrival order. The SSE
 * ring replays from `Last-Event-ID` on reconnect, so a resumed client receives events it already
 * rendered; keying on identity makes a replay idempotent where appending would double every re-seen
 * row.
 */
export function stepKey(step: { iteration: number; stepIndex: number }): string {
	return `${step.iteration}:${step.stepIndex}`;
}

/** Plan order: every step of iteration 0, then every step of iteration 1. */
function byPlanOrder(a: ScenarioStepRow, b: ScenarioStepRow): number {
	return a.iteration - b.iteration || a.stepIndex - b.stepIndex;
}

/**
 * The first index of a plan-ordered list whose row does not sort before `row`: where `row` belongs,
 * and where its own earlier copy would be. A binary search, not a re-sort and a scan (#730): the
 * list is sorted by construction, and sorting per event would re-establish an invariant never lost,
 * on every one of a 5,000-step run's events. The ordinary append is answered by the first
 * comparison below; a gap-resume that lands out of order still finds its seat rather than sitting
 * at the end.
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
 * Whether a replayed event says anything its row does not: the four fields a `step` event carries
 * that can differ between an execution's first delivery and a replay. Identity is not among them,
 * as two rows only reach this when they sort equal, which is exactly when `stepKey` would match.
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
 * A live step list and its summary, folded together. They travel as one because the summary is only
 * correct *for* these rows: the fold maintains it incrementally ({@link foldStepEvents}), so one
 * held without the other is a number nothing produced.
 */
export interface StepFold {
	steps: ScenarioStepRow[];
	summary: StepListSummary;
}

/** A fold, and what the batch that produced it disturbed. */
export interface StepFoldResult {
	/** The list and its summary after the batch. */
	fold: StepFold;
	/**
	 * Whether every row the batch changed landed at the end of the list: false when a replay
	 * replaced a row in place or a gap-resume spliced one in (the two cases that disturb rows
	 * already shown), true for the ordinary append and for a batch that changed nothing.
	 *
	 * `scenario-run-store` turns it into the epoch a filtered view needs to tell "the same list,
	 * longer" from "a different list" without comparing rows (#1205). The fold is the only place
	 * that knows: by the time the list reaches a reader, an appended row and a replaced one look
	 * alike.
	 */
	appendedOnly: boolean;
}

/**
 * Fold a batch of `step` events into the live list and its summary. **One commit per batch, one
 * copy per batch**: the list is rebuilt once here however many events the batch carries, where
 * folding them one at a time costs a full array copy each, quadratic over a run, and is why
 * `ScenarioRunService` buffers rather than committing per event (#1153).
 *
 * Returns the `current` fold itself when no event changed anything, so a replayed batch cannot
 * force a re-render. A later event for a key already present replaces it rather than being dropped:
 * the engine sends one event per step execution, so a second one for the key can only be a replay,
 * and the newer copy is the one to trust.
 */
export function foldStepEvents(
	current: StepFold,
	events: readonly ScenarioStepEvent[]
): StepFoldResult {
	// Null until an event actually changes something, which is what lets an
	// all-replay batch return `current` and commit nothing.
	let next: StepFold | null = null;
	let appendedOnly = true;

	for (const event of events) {
		const fold = next ?? current;
		const row: ScenarioStepRow = { ...event };
		/*
		 * One search answers "is this a replay?" and "where does a new row go?", because plan order
		 * *is* the identity order: two rows sort equal exactly when `stepKey` would match. A
		 * whole-list scan per event costs as much as the sort it would avoid on a long run.
		 */
		const at = planOrderIndex(fold.steps, row);
		const replacing = at < fold.steps.length && byPlanOrder(fold.steps[at], row) === 0;
		if (replacing && sameStepRow(fold.steps[at], row)) continue;

		next ??= { steps: [...current.steps], summary: cloneStepSummary(current.summary) };

		if (replacing) {
			applyStepRow(next.summary, next.steps[at], -1);
			next.steps[at] = row;
			appendedOnly = false;
		} else if (at === next.steps.length) {
			// Events arrive in plan order in the ordinary case, so this is an
			// append; a gap-resume that lands one out of order still finds its
			// seat below rather than sitting at the end.
			next.steps.push(row);
		} else {
			next.steps.splice(at, 0, row);
			appendedOnly = false;
		}
		applyStepRow(next.summary, row, 1);
	}

	return { fold: next ?? current, appendedOnly };
}

/**
 * The step identity the engine stamps onto a stored trace, when the row has one. A `results` row
 * without it is not a scenario step (a load run's report, or a row written before the runner
 * existed) and is skipped, not rendered as step 0 of iteration 0.
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
		...(typeof trace.stepsNotRun === "number" && trace.stepsNotRun > 0
			? { stepsNotRun: trace.stepsNotRun }
			: {}),
		...(typeof trace.extractorMisses === "number" && trace.extractorMisses > 0
			? { extractorMisses: trace.extractorMisses }
			: {}),
		...(typeof trace.unresolvedTokens === "number" && trace.unresolvedTokens > 0
			? { unresolvedTokens: trace.unresolvedTokens }
			: {}),
		// The stored trace's link back to its request (#730). A row written before the runner
		// stamped it has none, and the card offers no link rather than one to an empty id.
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
 * Everything the run tab's header says about a step list, one object because the live path
 * maintains all three fields incrementally ({@link foldStepEvents}) rather than scanning per
 * commit: three loose fields are three things a caller can hold half of.
 */
export interface StepListSummary {
	/**
	 * The outcomes, each its own number. `skipped` is never folded into `passed`: a skipped step
	 * asserted nothing, and reporting it as a pass is the false-pass class the run summary exists
	 * to avoid.
	 */
	counts: OutcomeCounts;
	/** Steps past the first pass; `> 0` means a row says which iteration it belongs to. */
	iterationSteps: number;
	/** How many steps recorded the `data` row their iteration bound. */
	dataBoundSteps: number;
}

/** The summary of a list with nothing in it. */
export function emptyStepSummary(): StepListSummary {
	return {
		counts: { passed: 0, failed: 0, skipped: 0, errored: 0, stopped: 0 },
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
 * Add one row to `summary`, or take one back out. Mutates: callers own the object they pass.
 *
 * Every field is a count, not a flag, and `sign` makes the fold reversible: a replay replacing a
 * row takes the old one out before putting the new one in. A latched boolean would save two
 * integers and be wrong as soon as a replacement stopped binding a data row (a replay is compared
 * on outcome, status, latency and name, not `dataRowIndex`), and knowing whether any *other* row
 * still binds one would mean the whole-list scan this summary avoids. Counting makes the
 * incremental summary equal {@link summarizeSteps} for any event sequence, assuming nothing about
 * what the engine replays.
 */
function applyStepRow(summary: StepListSummary, row: ScenarioStepRow, sign: 1 | -1): void {
	// A row whose outcome the engine did not name must not land in a bucket silently:
	// `stepRowFromResult` has already decided what an unstamped row counts as.
	if (row.outcome in summary.counts) summary.counts[row.outcome] += sign;
	if (row.iteration > 0) summary.iterationSteps += sign;
	if (row.dataRowIndex !== undefined) summary.dataBoundSteps += sign;
}

/**
 * Summarize a whole list in one pass. The stored path reads its summary here (its rows arrive
 * complete, with nothing to fold), and it is the oracle the live path's incremental summary is
 * checked against.
 */
export function summarizeSteps(steps: readonly ScenarioStepRow[]): StepListSummary {
	const summary = emptyStepSummary();
	for (const step of steps) applyStepRow(summary, step, 1);
	return summary;
}

/**
 * The run's outcome totals as the engine counted them, or `null` when the report cannot say (a live
 * run before its report arrives, or a sidecar older than these fields).
 *
 * These are **whole-run** counts (`report.scenario.passed/failed/...`, written from every step the
 * runner executed), not a tally of the stored rows. Thinning by `maxScenarioStoredSteps` drops only
 * passes, so counting rows undercounts `passed` on any run that filled its store: a 6,000-step run
 * keeping 5,000 rows would read "4,990 passed" beside a header claiming 6,000 steps. The stored-row
 * count stays the list's own disclosure (`thinningDisclosure`); the chips read the truth here.
 *
 * The first four are read defensively: an older report typed as carrying them may omit one at
 * runtime, and a partial read is worse than falling back to the rows wholesale. `stopped` (#3397)
 * is the exception: a report stored before it has none, which is a run with nothing stopped, not an
 * unreadable one.
 */
export function outcomeCountsFromReport(report: RunReport | undefined): OutcomeCounts | null {
	const scenario = report?.scenario;
	if (!scenario) return null;
	const { passed, failed, skipped, errored, stopped } = scenario;
	if (
		typeof passed !== "number" ||
		typeof failed !== "number" ||
		typeof skipped !== "number" ||
		typeof errored !== "number"
	) {
		return null;
	}
	return { passed, failed, skipped, errored, stopped: typeof stopped === "number" ? stopped : 0 };
}

/**
 * What the run's own store thinned away, or `null` when it dropped nothing (or is too old to say).
 * Without it `results[]` reads as the whole run: `stepsExecuted` is what the sequence did,
 * `stepsStored` what survived `maxScenarioStoredSteps`. Failures are kept first, so what is missing
 * is always successes, worth stating rather than leaving a reader to infer from two mismatched
 * numbers.
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

/**
 * "3 steps did not run", or `null` when `count` says nothing was lost. One sentence for both places
 * an error's cost is read (the header's run-wide `scenario.stepsNotRun`, and the step that ended
 * its iteration, #2526), so they cannot disagree on wording. The engine omits the field rather than
 * sending `0`, and an older report is `undefined`: neither is a claim, so neither renders.
 */
export function stepsNotRunText(count: number | undefined): string | null {
	if (typeof count !== "number" || !(count > 0)) return null;
	return `${formatNumber(count)} ${pluralize(count, "step")} did not run`;
}
