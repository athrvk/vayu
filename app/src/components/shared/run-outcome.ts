/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Did a load run pass, fail, or was it never judged (#2130)? `status` says how a run *ended*:
 * `completed` is ran-to-the-end, and a missed budget or half-erroring run is `completed` too, so
 * the success glyph would read as an unearned pass. This is the one place budgets and error rate
 * become a verdict, so the dashboard banner and header, the history detail's banner and the history
 * row's glyph cannot disagree.
 *
 * - **failed** - the status is `failed`, or a declared budget was missed.
 * - **passed** - every declared budget was met, no request errored and no check failed.
 * - **not-judged** - nothing declared a pass/fail line, or the run's errors undercut the budgets
 *   that passed (a latency ceiling met by all-instant 500s). Never green: no failure is not a pass.
 *
 * A failed check is evidence like an error: a scenario run whose every `assert.*` failed against
 * `200`s has 0% errors and met its latency budget (#2820). It is **not-judged**, as **failed** is
 * reserved for a declared line missed (a broken `maxAssertionFailureRatePct` is already `failed`
 * through the budgets). The failed checks are the run's assertion block (#3537), alike for every
 * load run kind: a failed assertion of either population, exact or replayed (#3458), an errored
 * element execution, a failed teardown script. The reason names each, on the met-budgets and
 * no-budgets line alike, in the run-report export's words and order
 * (`engine/tests/fixtures/run-verdict-conformance.json`).
 *
 * A collection run is judged by `judgeCollection`, from its row (`rowOutcome`) or opened report
 * (`collectionReportOutcome`, #3543), the same either way: **failed** when a step failed or errored
 * or a budget was missed (#3539), else `null`, met budgets included.
 *
 * A Stop cutting the end-of-run drain with requests outstanding leaves the run `completed` with the
 * budgets its answered requests met, but those are not the run: a cancelled request is in no total,
 * rate or latency, and the ones the drain awaited are its slowest and hung ones (#3538). Such a run
 * (`summary.drainCut`, absent unless a Stop cut something) is **not-judged**, naming how many went
 * unanswered and nothing else. It ranks below **failed** (a missed budget is already known) and
 * above every met-budget and no-budget reason, failed checks and errors included; a Stop before the
 * drain is **stopped**. The export's `drain_stopped` code is the same verdict.
 *
 * A budget the run could not measure (`evaluated: false`, #1484) is counted failed by the engine
 * (`passed: false`, in `failed`), so it lands in **failed** and is named like any missed budget.
 *
 * `null` means nothing to say: the run is pending or running, or its report or list summary is
 * missing. A banner on `null` renders nothing, as "not judged" over an unarrived report would claim
 * something about a run nobody looked at.
 */

import { formatNumber } from "@/lib/format-number";
import type { CollectionResultSummary, Run, RunReport, StoredRunOutcome } from "@/types";
import { formatErrorPercent, pickByCount, pluralize } from "@/modules/dashboard/utils/format";
import {
	failedCheckPhrases,
	failedChecksOf,
	reportAssertionsOf,
	rowAssertionsOf,
	type FailedChecks,
} from "./run-assertions";
import { budgetName } from "./threshold-metrics";

export type RunOutcome = "passed" | "failed" | "not-judged";

/** The word for each verdict - the banner's title and a row's accessible name. */
export const OUTCOME_TITLE: Record<RunOutcome, string> = {
	passed: "Passed",
	failed: "Failed",
	"not-judged": "Not judged",
};

export interface RunJudgement {
	outcome: RunOutcome;
	/** One line, no trailing full stop: it sits after a title and a dash. */
	reason: string;
}

/**
 * The failed checks (#3537) are optional: absent or 0 changes nothing, any positive count keeps met
 * budgets from reading `passed`.
 */
export interface RunOutcomeInput extends Partial<FailedChecks> {
	status: string;
	/**
	 * The report's budget block, whose metric names let the reason name what was missed; beats
	 * {@link verdict} when both are given.
	 */
	thresholdValidation?: RunReport["thresholdValidation"];
	/**
	 * The list row's budget verdict, for a caller without check names; absent means no budget
	 * judged the run.
	 */
	verdict?: "passed" | "failed";
	/** Percent, 0-100. Absent when the run recorded no request. */
	errorRate?: number;
	/** Requests a Stop cancelled in the end-of-run drain (#3538); absent or 0 means none. */
	drainCutCancelled?: number;
}

/** `15.1%`; a rate that exists but rounds to nothing reads `<0.1%`, never `0.0%`. */
export function formatErrorRate(percent: number): string {
	return `${formatErrorPercent(percent)}%`;
}

type Budgets =
	| { state: "none" }
	| { state: "met"; total?: number }
	| { state: "missed"; total?: number; missed?: number; names: string[] };

function readBudgets({
	thresholdValidation,
	verdict,
}: Pick<RunOutcomeInput, "thresholdValidation" | "verdict">): Budgets {
	if (thresholdValidation && thresholdValidation.checks.length > 0) {
		const { checks, passed, failed } = thresholdValidation;
		const total = passed + failed;
		if (failed === 0) return { state: "met", total };
		const names = checks
			.filter((check) => !check.passed)
			.map((check) => budgetName(check.metric));
		return { state: "missed", total, missed: failed, names };
	}
	if (verdict === "failed") return { state: "missed", names: [] };
	if (verdict === "passed") return { state: "met" };
	return { state: "none" };
}

function failedReason(budgets: Budgets): string {
	if (budgets.state !== "missed") return "The run failed before it finished";
	if (budgets.total === undefined || budgets.missed === undefined) return "Budgets missed";
	const noun = pluralize(budgets.total, "budget");
	return `${budgets.missed} of ${budgets.total} ${noun} missed: ${budgets.names.join(", ")}`;
}

/**
 * "1 of 3 budgets missed: p99" for a block that missed one, in the failed verdict's words, or
 * `null` when all were met or none declared; a collection run's terminal notification and spoken
 * ending say it after the step counts (#3539).
 */
export function missedBudgetsReason(
	thresholdValidation: RunReport["thresholdValidation"] | null | undefined
): string | null {
	const budgets = readBudgets({ thresholdValidation: thresholdValidation ?? undefined });
	return budgets.state === "missed" ? failedReason(budgets) : null;
}

function metReason(budgets: Extract<Budgets, { state: "met" }>): string {
	if (budgets.total === undefined) return "All budgets met";
	return pickByCount(budgets.total, {
		one: "The budget was met",
		other: `All ${budgets.total} budgets met`,
	});
}

function drainCutReason(cancelled: number): string {
	const requests = `${formatNumber(cancelled)} ${pluralize(cancelled, "request")}`;
	const was = pickByCount(cancelled, { one: "was", other: "were" });
	return `${requests} ${was} still unanswered when the drain was stopped`;
}

/**
 * The cancelled count of a `drainCut` block (a report's `summary`, a row's `resultSummary`), or
 * `undefined` unless a positive integer: the engine writes the block only for a cut that cancelled
 * something, and a malformed one must not make a run not-judged.
 */
export function drainCutCancelledOf(
	summary: { drainCut?: unknown } | undefined
): number | undefined {
	const drainCut = summary?.drainCut;
	if (typeof drainCut !== "object" || drainCut === null) return undefined;
	const { cancelled } = drainCut as { cancelled?: unknown };
	return typeof cancelled === "number" && Number.isInteger(cancelled) && cancelled > 0
		? cancelled
		: undefined;
}

/** The verdict for a run, or `null` when it is not (yet) a run that can be judged. */
export function judgeRun(input: RunOutcomeInput): RunJudgement | null {
	const { status, errorRate } = input;
	if (status === "stopped") {
		return { outcome: "not-judged", reason: "Stopped before it finished" };
	}
	if (status !== "completed" && status !== "failed") return null;

	const budgets = readBudgets(input);
	if (status === "failed" || budgets.state === "missed") {
		return { outcome: "failed", reason: failedReason(budgets) };
	}

	const { drainCutCancelled } = input;
	if (drainCutCancelled !== undefined && drainCutCancelled > 0) {
		return { outcome: "not-judged", reason: drainCutReason(drainCutCancelled) };
	}

	const errors =
		errorRate !== undefined && errorRate > 0 ? `${formatErrorRate(errorRate)} errors` : null;
	const checks = failedCheckPhrases(input);
	if (budgets.state === "met") {
		const met = metReason(budgets);
		const undercut = [errors, ...checks].filter(Boolean).join(", ");
		return undercut
			? { outcome: "not-judged", reason: `${met}, but ${undercut}` }
			: { outcome: "passed", reason: met };
	}

	const noBudgets = "No budgets set";
	const measured = errorRate === undefined ? null : (errors ?? "0.0% errors");
	const facts = [measured, ...checks].filter(Boolean).join(", ");
	return { outcome: "not-judged", reason: facts ? `${noBudgets}. ${facts}` : noBudgets };
}

/**
 * The verdict for a loaded report; `null` for a missing report or one without a status, which does
 * not say how the run ended.
 */
export function reportOutcome(report: RunReport | null | undefined): RunJudgement | null {
	const status = report?.metadata?.status;
	if (!report || !status) return null;
	const { totalRequests, errorRate } = report.summary ?? {};
	return judgeRun({
		status,
		thresholdValidation: report.thresholdValidation,
		...failedChecksOf(reportAssertionsOf(report)),
		drainCutCancelled: drainCutCancelledOf(report.summary),
		// A run that sent nothing has no error rate: the report's 0 is an empty denominator, not
		// 0.0% measured.
		errorRate: totalRequests && totalRequests > 0 ? errorRate : undefined,
	});
}

type StepCount = Exclude<keyof CollectionResultSummary, "verdict">;

/** A collection row's step outcomes in the order a line reads them; each key is also its word. */
const STEP_COUNTS: ReadonlyArray<StepCount> = ["passed", "failed", "errored", "skipped", "stopped"];

/** The step outcomes that make a collection run read as not clean. */
const UNCLEAN_STEP_COUNTS: ReadonlyArray<StepCount> = ["failed", "errored"];

/**
 * `2 passed, 1 failed, 4 errored`: the non-zero step counts among `which`, or `null`; a key the row
 * did not record reads as none, as the wire leaves it absent rather than zeroed.
 */
export function stepCountsPhrase(
	summary: CollectionResultSummary,
	which: ReadonlyArray<StepCount> = STEP_COUNTS
): string | null {
	const parts = STEP_COUNTS.filter((key) => which.includes(key) && (summary[key] ?? 0) > 0).map(
		(key) => `${formatNumber(summary[key])} ${key}`
	);
	return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * A completed collection run is not clean when a step failed or errored (#3458) or a budget was
 * missed (#3539): `completed` says the sequence ran to its end, not that steps or budgets held.
 * Either makes it `failed`, the reason naming both when both apply ("Budgets missed, 1 failed"). A
 * clean run answers `null` and keeps the status glyph, budgets met or none: a collection run is
 * never `passed`, as no row or report holds an error rate or check count that could undercut a met
 * budget ({@link judgeRun} judges load runs). The one core of {@link rowOutcome} and
 * {@link collectionReportOutcome}, which differ only in where counts and budgets come from, so the
 * row and the opened run's pill (#3543) agree.
 */
function judgeCollection(
	status: string | undefined,
	counts: CollectionResultSummary,
	budgets: Budgets
): RunJudgement | null {
	if (status !== "completed") return null;
	const reasons = [
		budgets.state === "missed" ? failedReason(budgets) : null,
		stepCountsPhrase(counts, UNCLEAN_STEP_COUNTS),
	].filter(Boolean);
	return reasons.length > 0 ? { outcome: "failed", reason: reasons.join(", ") } : null;
}

/**
 * A loaded collection run's verdict in the row's terms: the same steps and budget miss make it
 * `failed` (#3543). `null` for a clean run, one that did not complete, and a report without step
 * counts; the reason names the missed budgets, which the row cannot.
 */
export function collectionReportOutcome(report: RunReport | null | undefined): RunJudgement | null {
	if (!report?.scenario) return null;
	return judgeCollection(
		report.metadata?.status,
		report.scenario,
		readBudgets({ thresholdValidation: report.thresholdValidation })
	);
}

/** What a stored outcome says when the row's own numbers do not reach the same verdict. */
const STORED_OUTCOME_REASON = "Judged by Vayu's engine";

const OUTCOME_OF_STORED: Record<StoredRunOutcome, RunOutcome> = {
	passed: "passed",
	failed: "failed",
	not_judged: "not-judged",
};

const STORED_OF_OUTCOME: Record<RunOutcome, StoredRunOutcome> = {
	passed: "passed",
	failed: "failed",
	"not-judged": "not_judged",
};

/**
 * A `failed` status is the verdict for every run type, with or without a summary (#3643): the list
 * draws the failed mark from the status alone, so the verdict cannot rest on a summary the run died
 * before writing. The reason is the unnamed budget miss when the row's `verdict` says one was
 * missed, else "failed before it finished"; a design row's summary carries no verdict.
 */
function failedRowOutcome(run: Run): RunJudgement {
	const verdict = run.type === "design" ? undefined : run.resultSummary?.verdict;
	const budgets: Budgets =
		verdict === "failed" ? { state: "missed", names: [] } : { state: "none" };
	return { outcome: "failed", reason: failedReason(budgets) };
}

/**
 * The verdict a list row can state from its `status` and `resultSummary`. A failed row is always
 * `failed` ({@link failedRowOutcome}); otherwise only a terminal load or collection row has a
 * summary, so every other row, and one from an engine predating the summary, answers `null` and
 * keeps its glyph, as does a clean collection row, met budgets included.
 */
function derivedRowOutcome(run: Run): RunJudgement | null {
	if (run.status === "failed") return failedRowOutcome(run);
	if (!run.resultSummary) return null;
	if (run.type === "scenario") {
		const { verdict } = run.resultSummary;
		// The row names no budget, so a miss reads in the unnamed form.
		const budgets: Budgets =
			verdict === "failed" ? { state: "missed", names: [] } : { state: "none" };
		return judgeCollection(run.status, run.resultSummary, budgets);
	}
	if (run.type !== "load") return null;
	const { verdict, errorRate } = run.resultSummary;
	return judgeRun({
		status: run.status,
		verdict,
		errorRate,
		...failedChecksOf(rowAssertionsOf(run.resultSummary)),
		drainCutCancelled: drainCutCancelledOf(run.resultSummary),
	});
}

/**
 * The verdict a history row draws (#3547). The engine's stored `run.outcome` decides the category,
 * as `GET /runs?outcome=` filters on it, so a row is never listed under a verdict it does not wear;
 * the reason is the row's own derivation (`derivedRowOutcome`) when that reaches the same category
 * (every row where engine and renderer agree), else a generic line. A row with no stored outcome
 * (stored before the column, or judged nothing) is derived from `status` and `resultSummary`, the
 * rule the engine's `judge_run_row` is held to by
 * `engine/tests/fixtures/run-row-outcome-conformance.json`. So a failed row stored before the
 * column wears `failed` here while its column stays NULL, and the History outcome filter, fetching
 * through `GET /runs?outcome=failed`, misses it (#3643).
 */
export function rowOutcome(run: Run): RunJudgement | null {
	const derived = derivedRowOutcome(run);
	if (run.outcome === undefined) return derived;
	const outcome = OUTCOME_OF_STORED[run.outcome];
	if (!outcome) return derived;
	return derived?.outcome === outcome ? derived : { outcome, reason: STORED_OUTCOME_REASON };
}

/**
 * The verdict as a lowercase word beside the status (`completed, verdict failed`), or `null` when
 * it adds nothing: no verdict, or a `failed` status, which always judges failed (#3643), so the
 * pair would read "failed, verdict failed".
 */
export function verdictBesideStatus(
	status: Run["status"],
	judgement: RunJudgement | null
): string | null {
	if (!judgement) return null;
	if (status === "failed" && judgement.outcome === "failed") return null;
	return OUTCOME_TITLE[judgement.outcome].toLowerCase();
}

/**
 * The row's verdict in the engine's spelling (what `GET /runs?outcome=` takes and `run.outcome`
 * holds); `null` where {@link rowOutcome} draws none, which is also where the engine stores none
 * and matches no filter.
 */
export function rowStoredOutcome(run: Run): StoredRunOutcome | null {
	const judged = rowOutcome(run);
	return judged ? STORED_OF_OUTCOME[judged.outcome] : null;
}
