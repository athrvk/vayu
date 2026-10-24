/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The verdict a load run gets (#2130). `completed` says the run ended, not that
 * the target held up, so the verdict is a table of (status, budgets, errors).
 *
 * Mutation check: make `judgeRun` answer `passed` for a missed budget and the
 * missed-budget, verdict-only and failed-status rows redden; drop the
 * `errors` branch of the met case and the met-with-errors row reddens; ignore
 * `assertionsFailed` in `judgeRun` and every assertion row reddens, and ignore
 * the report's or the row's source for it and the `reportOutcome` / `rowOutcome`
 * cases do (#2820).
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { stubNumberLocale } from "@/test/number-locale";
import type { Run, RunReport } from "@/types";
import {
	formatErrorRate,
	judgeRun,
	reportOutcome,
	rowOutcome,
	type RunOutcomeInput,
} from "./run-outcome";

type Budgets = NonNullable<RunReport["thresholdValidation"]>;

let restoreLocale: () => void;
beforeEach(() => {
	restoreLocale = stubNumberLocale("en-US");
});
afterEach(() => restoreLocale());

function budgets(
	...checks: Array<[metric: string, passed: boolean, evaluated?: boolean]>
): Budgets {
	const rows = checks.map(([metric, passed, evaluated]) => ({
		metric,
		limit: 100,
		passed,
		...(evaluated === undefined ? {} : { evaluated }),
	}));
	const failed = rows.filter((row) => !row.passed).length;
	return {
		checks: rows,
		passed: rows.length - failed,
		failed,
		verdict: failed === 0 ? "passed" : "failed",
	};
}

const THREE_MET = budgets(
	["latencyP95Ms", true],
	["minThroughputRps", true],
	["maxErrorRatePct", true]
);
const TWO_OF_FOUR_MISSED = budgets(
	["latencyP95Ms", false],
	["latencyP99Ms", true],
	["minThroughputRps", false],
	["maxErrorRatePct", true]
);

const CASES: Array<[name: string, input: RunOutcomeInput, expected: unknown]> = [
	[
		"a missed budget names what was missed",
		{ status: "completed", thresholdValidation: TWO_OF_FOUR_MISSED, errorRate: 0 },
		{ outcome: "failed", reason: "2 of 4 budgets missed: p95, throughput" },
	],
	[
		"a single missed budget",
		{ status: "completed", thresholdValidation: budgets(["latencyP99Ms", false]) },
		{ outcome: "failed", reason: "1 of 1 budget missed: p99" },
	],
	[
		"a budget this build has no short name for keeps its key",
		{
			status: "completed",
			thresholdValidation: budgets(["custom.checkout_ms.p95", false], ["latencyP50Ms", true]),
		},
		{ outcome: "failed", reason: "1 of 2 budgets missed: custom.checkout_ms.p95" },
	],
	[
		"a budget with no samples counts as missed, the way the engine tallies it",
		{
			status: "completed",
			thresholdValidation: budgets(
				["latencyP95Ms", false, false],
				["maxErrorRatePct", true, true]
			),
		},
		{ outcome: "failed", reason: "1 of 2 budgets missed: p95" },
	],
	[
		"every budget met and no errors",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0 },
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	[
		"one budget met and no errors",
		{ status: "completed", thresholdValidation: budgets(["latencyP95Ms", true]), errorRate: 0 },
		{ outcome: "passed", reason: "The budget was met" },
	],
	[
		"budgets met but the run's responses errored",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 15.1 },
		{ outcome: "not-judged", reason: "All 3 budgets met, but 15.1% errors" },
	],
	[
		"budgets met and an error rate that rounds to zero is still errors",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0.01 },
		{ outcome: "not-judged", reason: "All 3 budgets met, but <0.1% errors" },
	],
	[
		"budgets met with no error rate recorded does not invent errors",
		{ status: "completed", thresholdValidation: THREE_MET },
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	[
		"no budgets and errors",
		{ status: "completed", errorRate: 15.1 },
		{ outcome: "not-judged", reason: "No budgets set. 15.1% errors" },
	],
	[
		"no budgets and no errors is still not a pass",
		{ status: "completed", errorRate: 0 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors" },
	],
	[
		"no budgets and no error rate",
		{ status: "completed" },
		{ outcome: "not-judged", reason: "No budgets set" },
	],
	[
		"an empty budget block is no budgets",
		{
			status: "completed",
			thresholdValidation: { checks: [], passed: 0, failed: 0, verdict: "passed" },
			errorRate: 0,
		},
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors" },
	],
	[
		"a failed status is failed even with every budget met",
		{ status: "failed", thresholdValidation: THREE_MET, errorRate: 0 },
		{ outcome: "failed", reason: "The run failed before it finished" },
	],
	[
		"a failed status with missed budgets names them",
		{ status: "failed", thresholdValidation: TWO_OF_FOUR_MISSED },
		{ outcome: "failed", reason: "2 of 4 budgets missed: p95, throughput" },
	],
	[
		"a stopped run is not judged, whatever its partial numbers say",
		{ status: "stopped", thresholdValidation: TWO_OF_FOUR_MISSED, errorRate: 40 },
		{ outcome: "not-judged", reason: "Stopped before it finished" },
	],
	// The list row has the verdict and no check names.
	[
		"a row verdict of failed",
		{ status: "completed", verdict: "failed", errorRate: 0 },
		{ outcome: "failed", reason: "Budgets missed" },
	],
	[
		"a row verdict of passed",
		{ status: "completed", verdict: "passed", errorRate: 0 },
		{ outcome: "passed", reason: "All budgets met" },
	],
	[
		"a row verdict of passed with errors",
		{ status: "completed", verdict: "passed", errorRate: 3 },
		{ outcome: "not-judged", reason: "All budgets met, but 3.0% errors" },
	],
	[
		"a row with no verdict was not judged",
		{ status: "completed", errorRate: 3 },
		{ outcome: "not-judged", reason: "No budgets set. 3.0% errors" },
	],
	// #2820: an HTTP-clean run whose assertions failed is never a pass.
	[
		"no budgets and failed assertions at 0% errors",
		{ status: "completed", errorRate: 0, assertionsFailed: 4580 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 4,580 assertions failed" },
	],
	[
		"no budgets and one failed assertion reads singular",
		{ status: "completed", errorRate: 0, assertionsFailed: 1 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 1 assertion failed" },
	],
	[
		"no budgets, errors and failed assertions",
		{ status: "completed", errorRate: 15.1, assertionsFailed: 12 },
		{ outcome: "not-judged", reason: "No budgets set. 15.1% errors, 12 assertions failed" },
	],
	[
		"no budgets, no error rate recorded and failed assertions",
		{ status: "completed", assertionsFailed: 12 },
		{ outcome: "not-judged", reason: "No budgets set. 12 assertions failed" },
	],
	[
		"met budgets never pass over failed assertions",
		{
			status: "completed",
			thresholdValidation: budgets(["latencyP95Ms", true]),
			errorRate: 0,
			assertionsFailed: 4580,
		},
		{
			outcome: "not-judged",
			reason: "The budget was met, but 0.0% errors, 4,580 assertions failed",
		},
	],
	[
		"met budgets with errors and failed assertions",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 3, assertionsFailed: 2 },
		{
			outcome: "not-judged",
			reason: "All 3 budgets met, but 3.0% errors, 2 assertions failed",
		},
	],
	[
		"a row verdict of passed with failed assertions",
		{ status: "completed", verdict: "passed", errorRate: 0, assertionsFailed: 5 },
		{ outcome: "not-judged", reason: "All budgets met, but 0.0% errors, 5 assertions failed" },
	],
	[
		"a missed budget keeps its own reason beside failed assertions",
		{
			status: "completed",
			thresholdValidation: TWO_OF_FOUR_MISSED,
			errorRate: 0,
			assertionsFailed: 5,
		},
		{ outcome: "failed", reason: "2 of 4 budgets missed: p95, throughput" },
	],
	[
		"zero failed assertions change nothing",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0, assertionsFailed: 0 },
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	["a pending run has nothing to say", { status: "pending" }, null],
	["a running run has nothing to say", { status: "running", errorRate: 50 }, null],
	["a status this build does not know has nothing to say", { status: "queued" }, null],
];

describe("judgeRun", () => {
	it("covers the table", () => {
		expect(CASES.length).toBeGreaterThan(20);
	});

	it.each(CASES)("%s", (_name, input, expected) => {
		expect(judgeRun(input)).toEqual(expected);
	});

	it("lets the report's check names win over a row verdict", () => {
		const judged = judgeRun({
			status: "completed",
			thresholdValidation: TWO_OF_FOUR_MISSED,
			verdict: "passed",
		});
		expect(judged?.outcome).toBe("failed");
	});
});

describe("formatErrorRate", () => {
	it.each([
		[0, "0.0%"],
		[0.01, "<0.1%"],
		[0.05, "0.1%"],
		[15.14, "15.1%"],
		[100, "100.0%"],
	])("%s is %s", (percent, text) => {
		expect(formatErrorRate(percent)).toBe(text);
	});
});

function report(overrides: Partial<RunReport> & { status?: string } = {}): RunReport {
	const { status = "completed", ...rest } = overrides;
	return {
		metadata: { runId: "run_1", runType: "load", status, startTime: 0, endTime: 1 },
		summary: { totalRequests: 100, successfulRequests: 100, failedRequests: 0, errorRate: 0 },
		...rest,
	} as RunReport;
}

describe("reportOutcome", () => {
	it("judges a finished report off its budgets and error rate", () => {
		expect(reportOutcome(report({ thresholdValidation: THREE_MET }))).toEqual({
			outcome: "passed",
			reason: "All 3 budgets met",
		});
	});

	it("reads the report's scenario assertion tally", () => {
		const scenario = {
			assertions: { passed: 0, failed: 4580 },
		} as NonNullable<RunReport["scenario"]>;
		expect(reportOutcome(report({ scenario }))).toEqual({
			outcome: "not-judged",
			reason: "No budgets set. 0.0% errors, 4,580 assertions failed",
		});
	});

	it("groups the failed count the way the host's locale does", () => {
		restoreLocale();
		restoreLocale = stubNumberLocale("de-DE");
		const scenario = {
			assertions: { passed: 0, failed: 4580 },
		} as NonNullable<RunReport["scenario"]>;
		expect(reportOutcome(report({ scenario }))?.reason).toBe(
			"No budgets set. 0.0% errors, 4.580 assertions failed"
		);
	});

	it("is unchanged for a report whose scenario has no tally, or none failed", () => {
		const clean = { assertions: { passed: 10, failed: 0 } } as NonNullable<
			RunReport["scenario"]
		>;
		const old = {} as NonNullable<RunReport["scenario"]>;
		for (const scenario of [clean, old]) {
			expect(reportOutcome(report({ scenario }))?.reason).toBe("No budgets set. 0.0% errors");
		}
	});

	it("says nothing for a missing report, or one that does not say how the run ended", () => {
		expect(reportOutcome(undefined)).toBeNull();
		expect(reportOutcome(null)).toBeNull();
		expect(reportOutcome({ ...report(), metadata: undefined })).toBeNull();
	});

	it("says nothing for a report of a run that is still going", () => {
		expect(reportOutcome(report({ status: "running" }))).toBeNull();
	});

	it("does not call an empty report error-free", () => {
		const empty = report({
			summary: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, errorRate: 0 },
		} as Partial<RunReport>);
		expect(reportOutcome(empty)?.reason).toBe("No budgets set");
	});
});

function row(over: Partial<Run>): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 0,
		endTime: 1,
		...over,
	} as Run;
}

describe("rowOutcome", () => {
	it("judges a load row from its resultSummary alone", () => {
		expect(
			rowOutcome(
				row({ resultSummary: { rps: 485, p95Ms: 42, errorRate: 0, verdict: "failed" } })
			)
		).toEqual({ outcome: "failed", reason: "Budgets missed" });
	});

	it("reads the row's failed assertions, so the glyph cannot go green over them", () => {
		const judged = rowOutcome(
			row({
				resultSummary: {
					rps: 41,
					p95Ms: 63,
					errorRate: 0,
					verdict: "passed",
					assertionsPassed: 0,
					assertionsFailed: 300,
				},
			})
		);
		expect(judged).toEqual({
			outcome: "not-judged",
			reason: "All budgets met, but 0.0% errors, 300 assertions failed",
		});
	});

	it("says nothing for a load row with no summary, so the status glyph stays", () => {
		expect(rowOutcome(row({}))).toBeNull();
	});

	it("says nothing for a design or collection row, whatever it carries", () => {
		expect(
			rowOutcome(row({ type: "design", resultSummary: { statusCode: 500, latencyMs: 3 } }))
		).toBeNull();
		expect(rowOutcome(row({ type: "scenario" }))).toBeNull();
	});
});
