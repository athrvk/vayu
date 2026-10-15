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
import { pluralize } from "@/modules/dashboard/utils/format";
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
}

/** Requests per second, thousands separated: `12,400`; one decimal below 10 so a slow run is not `0`. */
export function formatRps(value: number): string {
	if (value > 0 && value < 10) return value.toFixed(1);
	return Math.round(value).toLocaleString("en-US");
}

/** `15.1%`; a rate that exists but rounds to nothing reads `<0.1%`, never `0.0%`. */
export function formatErrorRate(percent: number): string {
	if (percent > 0 && percent < 0.05) return "<0.1%";
	return `${percent.toFixed(1)}%`;
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
	return budgets.total === 1 ? "The budget was met" : `All ${budgets.total} budgets met`;
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
	if (budgets.state === "met") {
		const met = metReason(budgets);
		return errors
			? { outcome: "not-judged", reason: `${met}, but ${errors}` }
			: { outcome: "passed", reason: met };
	}

	const noBudgets = "No budgets set";
	const measured = errorRate === undefined ? null : (errors ?? "0.0% errors");
	return { outcome: "not-judged", reason: measured ? `${noBudgets}. ${measured}` : noBudgets };
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
	const { verdict, errorRate } = run.resultSummary;
	return judgeRun({ status: run.status, verdict, errorRate });
}
