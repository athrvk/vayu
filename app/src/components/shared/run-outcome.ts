/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Did a load run pass, fail, or was it never judged (#2130)?
 *
 * `status` says how a run *ended*: `completed` means it ran to its end, not that
 * the target held up. A run with a missed budget, or with half its responses
 * erroring, is still `completed`, and drawing it with the success glyph reads as
 * a pass nobody earned. This is the one place that turns a run's budgets and its
 * error rate into a verdict, so the dashboard banner and header, the history
 * detail's banner and the history list's row glyph cannot disagree.
 *
 * - **failed** - the run's status is `failed`, or a declared budget was missed.
 * - **passed** - every declared budget was met and no request errored.
 * - **not-judged** - nothing declared a pass/fail line, or the run's own errors
 *   undercut the budgets that passed (a latency ceiling can be met by a run whose
 *   responses are all instant 500s). Never green: absence of a failure is not a
 *   pass.
 *
 * A failed assertion (#2820) is the same kind of evidence as an error: a scenario
 * load run whose every `assert.*` failed against `200`s has a 0% error rate and
 * met its latency budget, and drawing it green says the checks held. It is
 * **not-judged**, not **failed**, because **failed** is reserved for a line the
 * run declared and missed - a run that declared `maxAssertionFailureRatePct`
 * and broke it is already `failed` through its budgets. The reason names the
 * count either way.
 *
 * A budget the run could not measure (`evaluated: false`, issue #1484) is
 * counted by the engine as failed (`passed: false`, in `failed`), so it lands in
 * **failed** here and is named like any other missed budget.
 *
 * `null` means there is nothing to say: the run is still pending or running, or
 * its report or list summary is missing. A banner built on `null` renders
 * nothing, because "not judged" over a report that has not arrived would claim
 * something about a run that has not been looked at.
 */

import type { Run, RunReport } from "@/types";
import { formatErrorPercent, pickByCount, pluralize } from "@/modules/dashboard/utils/format";
import { assertionsFailedPhrase, exactAssertionsOf } from "./run-assertions";
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

export interface RunOutcomeInput {
	status: string;
	/**
	 * The report's budget block - carries the metric names, so the reason can
	 * name what was missed. Wins over {@link verdict} when both are given.
	 */
	thresholdValidation?: RunReport["thresholdValidation"];
	/**
	 * The list row's budget verdict, for a caller with no check names. Absent
	 * means no budget judged the run.
	 */
	verdict?: "passed" | "failed";
	/** Percent, 0-100. Absent when the run recorded no request. */
	errorRate?: number;
	/**
	 * Failed exact assertions of a scenario load run (#2820). Any positive count
	 * keeps the run from reading `passed`; absent or 0 changes nothing.
	 */
	assertionsFailed?: number;
}

/** `15.1%`; a rate that exists but rounds to nothing reads `<0.1%`, never `0.0%`. */
export function formatErrorRate(percent: number): string {
	return `${formatErrorPercent(percent)}%`;
}

type Budgets =
	| { state: "none" }
	| { state: "met"; total?: number }
	| { state: "missed"; total?: number; missed?: number; names: string[] };

function readBudgets({ thresholdValidation, verdict }: RunOutcomeInput): Budgets {
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

function metReason(budgets: Extract<Budgets, { state: "met" }>): string {
	if (budgets.total === undefined) return "All budgets met";
	return pickByCount(budgets.total, {
		one: "The budget was met",
		other: `All ${budgets.total} budgets met`,
	});
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

	const errors =
		errorRate !== undefined && errorRate > 0 ? `${formatErrorRate(errorRate)} errors` : null;
	const assertions = assertionsFailedPhrase(input.assertionsFailed);
	if (budgets.state === "met") {
		const met = metReason(budgets);
		const undercut = [errors, assertions].filter(Boolean).join(", ");
		return undercut
			? { outcome: "not-judged", reason: `${met}, but ${undercut}` }
			: { outcome: "passed", reason: met };
	}

	const noBudgets = "No budgets set";
	const measured = errorRate === undefined ? null : (errors ?? "0.0% errors");
	const facts = [measured, assertions].filter(Boolean).join(", ");
	return { outcome: "not-judged", reason: facts ? `${noBudgets}. ${facts}` : noBudgets };
}

/**
 * The verdict for a loaded report. `null` for a missing report and for one
 * without a status, which is a report that does not say how the run ended.
 */
export function reportOutcome(report: RunReport | null | undefined): RunJudgement | null {
	const status = report?.metadata?.status;
	if (!report || !status) return null;
	const { totalRequests, errorRate } = report.summary ?? {};
	return judgeRun({
		status,
		thresholdValidation: report.thresholdValidation,
		assertionsFailed: exactAssertionsOf(report)?.failed,
		// A run that sent nothing has no error rate; the report's 0 there is
		// an empty denominator, not 0.0% measured.
		errorRate: totalRequests && totalRequests > 0 ? errorRate : undefined,
	});
}

/**
 * The verdict a history list row can state from its own `resultSummary`. Only a
 * terminal load run's row carries one; every other row, and a load row from an
 * engine that predates the summary, answers `null` and keeps its status glyph.
 */
export function rowOutcome(run: Run): RunJudgement | null {
	if (run.type !== "load" || !run.resultSummary) return null;
	const { verdict, errorRate, assertionsFailed } = run.resultSummary;
	return judgeRun({ status: run.status, verdict, errorRate, assertionsFailed });
}
