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
 * `errors` branch of the met case and the met-with-errors row reddens.
 *
 * Failed assertions (#2820): make `judgeRun` ignore `assertionsFailed` and every
 * assertion row, and both wrapper tests, redden; make `reportOutcome` or
 * `rowOutcome` stop passing it and only that wrapper's test reddens.
 *
 * A single-request run's failures (#3458): make `failedAssertionsOf` stop
 * summing `elements` and the exact-names case reddens; stop reading
 * `testValidation` and the sampled-names case reddens; drop the scenario guard
 * and the no-double-count case reddens.
 */

import { describe, it, expect } from "vitest";
import type { Run, RunReport } from "@/types";
import {
	formatErrorRate,
	judgeRun,
	reportOutcome,
	rowOutcome,
	type RunOutcomeInput,
} from "./run-outcome";

type Budgets = NonNullable<RunReport["thresholdValidation"]>;

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
		"a missed stream budget is named by its short name (#3234)",
		{
			status: "completed",
			thresholdValidation: budgets(
				["streamTimeToFirstEventP95Ms", false],
				["streamEventsPerSecondMin", false, false]
			),
		},
		{ outcome: "failed", reason: "2 of 2 budgets missed: time to first event p95, event rate" },
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
	// A run whose assertions all failed against 200s has 0% errors and its latency
	// budget met: never green, and not "failed" either, which is a declared line.
	[
		"budgets met at 0% errors but assertions failed is not a pass",
		{
			status: "completed",
			thresholdValidation: budgets(["latencyP95Ms", true]),
			errorRate: 0,
			assertionsFailed: 4580,
		},
		{ outcome: "not-judged", reason: "The budget was met, but 4,580 assertions failed" },
	],
	[
		"budgets met with both errors and failed assertions names both",
		{
			status: "completed",
			thresholdValidation: THREE_MET,
			errorRate: 15.1,
			assertionsFailed: 2,
		},
		{
			outcome: "not-judged",
			reason: "All 3 budgets met, but 15.1% errors, 2 assertions failed",
		},
	],
	[
		"a row verdict of passed with failed assertions is not a pass",
		{ status: "completed", verdict: "passed", errorRate: 0, assertionsFailed: 7 },
		{ outcome: "not-judged", reason: "All budgets met, but 7 assertions failed" },
	],
	[
		"no budgets, 0% errors and failed assertions",
		{ status: "completed", errorRate: 0, assertionsFailed: 4580 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 4,580 assertions failed" },
	],
	[
		"a single failed assertion is singular",
		{ status: "completed", errorRate: 0, assertionsFailed: 1 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 1 assertion failed" },
	],
	[
		"failed assertions with no error rate recorded",
		{ status: "completed", assertionsFailed: 3 },
		{ outcome: "not-judged", reason: "No budgets set. 3 assertions failed" },
	],
	[
		"zero failed assertions changes nothing",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0, assertionsFailed: 0 },
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	// A single-request run's two populations (#3458): the reason says which.
	[
		"sampled failures are named as a replay's",
		{
			status: "completed",
			thresholdValidation: budgets(["latencyP95Ms", true]),
			errorRate: 0,
			sampledAssertionsFailed: 4,
		},
		{
			outcome: "not-judged",
			reason: "The budget was met, but 4 assertions failed in the sampled replay",
		},
	],
	[
		"exact and sampled failures are both named",
		{
			status: "completed",
			thresholdValidation: budgets(["latencyP95Ms", true]),
			errorRate: 0,
			assertionsFailed: 150,
			sampledAssertionsFailed: 4,
		},
		{
			outcome: "not-judged",
			reason: "The budget was met, but 150 assertions failed, 4 more in the sampled replay",
		},
	],
	[
		"sampled failures with no budgets",
		{ status: "completed", errorRate: 0, sampledAssertionsFailed: 1 },
		{
			outcome: "not-judged",
			reason: "No budgets set. 0.0% errors, 1 assertion failed in the sampled replay",
		},
	],
	[
		"zero sampled failures changes nothing",
		{
			status: "completed",
			thresholdValidation: THREE_MET,
			errorRate: 0,
			sampledAssertionsFailed: 0,
		},
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	[
		"a missed budget stays failed and does not take the assertion count",
		{ status: "completed", thresholdValidation: TWO_OF_FOUR_MISSED, assertionsFailed: 9 },
		{ outcome: "failed", reason: "2 of 4 budgets missed: p95, throughput" },
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

	it("reads the report's exact assertions, so a clean-HTTP run with failures is not a pass", () => {
		const withFailures = report({
			thresholdValidation: THREE_MET,
			scenario: { assertions: { passed: 10, failed: 4580 } },
		} as Partial<RunReport>);
		expect(reportOutcome(withFailures)).toEqual({
			outcome: "not-judged",
			reason: "All 3 budgets met, but 4,580 assertions failed",
		});
	});

	// #3458: a single-request report has no `scenario`; its exact tallies are the
	// top-level elements and its sampled ones `testValidation`.
	it("names the exact count when an inline script's tests fail, so the run is not a pass", () => {
		const inline = report({
			thresholdValidation: THREE_MET,
			elements: [
				{ id: "a", kind: "assert.status", passed: 150, failed: 0, skipped: 0 },
				{ id: "b", kind: "script.post", passed: 0, failed: 150, skipped: 0 },
			],
		} as Partial<RunReport>);
		expect(reportOutcome(inline)).toEqual({
			outcome: "not-judged",
			reason: "All 3 budgets met, but 150 assertions failed",
		});
	});

	it("names the sampled replay when only testValidation failed", () => {
		const sampled = report({
			thresholdValidation: THREE_MET,
			testValidation: { samplesTested: 8, testsPassed: 4, testsFailed: 4, successRate: 50 },
		} as Partial<RunReport>);
		expect(reportOutcome(sampled)).toEqual({
			outcome: "not-judged",
			reason: "All 3 budgets met, but 4 assertions failed in the sampled replay",
		});
	});

	it("names both populations without folding them into one count", () => {
		const both = report({
			thresholdValidation: THREE_MET,
			elements: [{ id: "b", kind: "script.post", passed: 0, failed: 150, skipped: 0 }],
			testValidation: { samplesTested: 8, testsPassed: 4, testsFailed: 4, successRate: 50 },
		} as Partial<RunReport>);
		expect(reportOutcome(both)?.reason).toBe(
			"All 3 budgets met, but 150 assertions failed, 4 more in the sampled replay"
		);
	});

	it("still reads passed when a single-request run's elements all passed", () => {
		const clean = report({
			thresholdValidation: THREE_MET,
			elements: [{ id: "b", kind: "script.post", passed: 150, failed: 0, skipped: 0 }],
			testValidation: { samplesTested: 8, testsPassed: 8, testsFailed: 0, successRate: 100 },
		} as Partial<RunReport>);
		expect(reportOutcome(clean)?.outcome).toBe("passed");
	});

	it("does not add a scenario report's top-level fields to its exact assertions", () => {
		const scenario = report({
			thresholdValidation: THREE_MET,
			scenario: { assertions: { passed: 10, failed: 2 } },
			elements: [{ id: "b", kind: "script.post", passed: 0, failed: 50, skipped: 0 }],
			testValidation: { samplesTested: 8, testsPassed: 4, testsFailed: 4, successRate: 50 },
		} as Partial<RunReport>);
		expect(reportOutcome(scenario)?.reason).toBe("All 3 budgets met, but 2 assertions failed");
	});

	it("leaves a scenario report with no assertions block as it was", () => {
		const without = report({
			thresholdValidation: THREE_MET,
			scenario: { passed: 3 },
		} as Partial<RunReport>);
		expect(reportOutcome(without)?.outcome).toBe("passed");
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

	it("reads the row's failed assertions, the same verdict the report gives", () => {
		expect(
			rowOutcome(
				row({
					resultSummary: {
						errorRate: 0,
						verdict: "passed",
						assertionsPassed: 10,
						assertionsFailed: 4580,
					},
				})
			)
		).toEqual({
			outcome: "not-judged",
			reason: "All budgets met, but 4,580 assertions failed",
		});
	});

	it("reads a single-request row's failed assertions off the same key", () => {
		expect(
			rowOutcome(
				row({ resultSummary: { errorRate: 0, verdict: "passed", assertionsFailed: 150 } })
			)
		).toEqual({
			outcome: "not-judged",
			reason: "All budgets met, but 150 assertions failed",
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
