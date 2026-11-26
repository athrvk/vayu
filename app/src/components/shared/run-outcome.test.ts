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
 * and the no-double-count case reddens. Make `rowOutcome` return `null` for a
 * collection row and the collection cases redden; read only `failed` and the
 * errored-only case reddens.
 *
 * The assertion block (#3537): make `reportAssertionsOf` read a scenario
 * report's `scenario.assertions` before its block (the old `sampled: 0`) and
 * the sampled-replay scenario case reddens; drop the `elementsErrored` or
 * `teardownsFailed` phrase from `failedCheckPhrases` and the errored-only or
 * teardown-only cases redden, on both branches; make `rowOutcome` read the
 * flat `assertionsFailed` instead of `rowAssertionsOf` and the row block cases
 * redden. The conformance replay below reddens on any reason worded apart from
 * the engine's.
 *
 * A collection run's budgets (#3539): make `judgeCollection` ignore a missed
 * budget and the missed-budget cases redden, on the row and the report alike;
 * make it read a met budget as worth an outcome and the met-budgets glyph case
 * reddens; drop its `completed` gate and the non-completed case reddens.
 *
 * An opened collection run's pill (#3543): make `collectionReportOutcome`
 * return `null` and its failed, errored and missed-budget cases and the parity
 * table redden; read `report.thresholdValidation` as met always and the
 * missed-budget cases redden; stop reading `report.metadata.status` and the
 * non-completed case reddens.
 *
 * A drain cut (#3538): drop `drainCutCancelled` from `judgeRun` and the drain
 * rows and the fixture's drain_stopped cases redden; move its branch above the
 * failed/missed-budget one and the ordering rows redden; make `reportOutcome` or
 * `rowOutcome` stop passing it and only that wrapper's drain test reddens.
 *
 * A stored outcome (#3547): make `rowOutcome` ignore `run.outcome` and the
 * stored-wins cases redden; map `not_judged` to `failed` and its case reddens;
 * return the derivation's reason whatever the category and the generic-reason
 * case reddens. The row-outcome replay reddens on any derivation that parts
 * from `run-row-outcome-conformance.json`, the engine's table: let a clean
 * collection row read `passed`, or a stopped collection row `failed`.
 *
 * A failed status (#3643): take the `failed` branch out of `derivedRowOutcome`
 * and the failed-status row cases and the fixture's failed-status cases redden;
 * let `verdictBesideStatus` answer for a failed status and its own case and the
 * `verdict failed` suffix the palette, history, welcome and context-bar rows
 * must not carry redden.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { Run, RunReport } from "@/types";
import {
	collectionReportOutcome,
	formatErrorRate,
	judgeRun,
	missedBudgetsReason,
	reportOutcome,
	rowOutcome,
	rowStoredOutcome,
	verdictBesideStatus,
	type RunJudgement,
	type RunOutcome,
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
		"a missed first match budget is named by its short name (#3774)",
		{
			status: "completed",
			thresholdValidation: budgets(["streamTimeToFirstMatchP95Ms", false, false]),
		},
		{ outcome: "failed", reason: "1 of 1 budget missed: time to first match p95" },
	],
	[
		"a missed MCP error class budget is named by its short name (#3830)",
		{
			status: "completed",
			thresholdValidation: budgets(
				["maxToolErrors", false],
				["maxProtocolErrors", false],
				["maxTransportErrors", false],
				["maxToolErrorRatePct", false],
				["maxProtocolErrorRatePct", false],
				["maxTransportErrorRatePct", false]
			),
		},
		{
			outcome: "failed",
			reason: "6 of 6 budgets missed: tool errors, protocol errors, transport errors, tool error rate, protocol error rate, transport error rate",
		},
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
	// Element errors and failed teardowns (#3537), after the assertions.
	[
		"budgets met at 0% errors but an element errored is not a pass",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0, elementsErrored: 997 },
		{ outcome: "not-judged", reason: "All 3 budgets met, but 997 elements errored" },
	],
	[
		"budgets met but a teardown failed is not a pass",
		{ status: "completed", thresholdValidation: THREE_MET, errorRate: 0, teardownsFailed: 1 },
		{ outcome: "not-judged", reason: "All 3 budgets met, but 1 teardown script failed" },
	],
	[
		"no budgets names an errored element",
		{ status: "completed", errorRate: 0, elementsErrored: 1 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 1 element errored" },
	],
	[
		"no budgets names failed teardowns",
		{ status: "completed", errorRate: 0, teardownsFailed: 2 },
		{ outcome: "not-judged", reason: "No budgets set. 0.0% errors, 2 teardown scripts failed" },
	],
	[
		"every failed check is named, errors first, then assertions, elements and teardowns",
		{
			status: "completed",
			thresholdValidation: THREE_MET,
			errorRate: 0.4,
			assertionsFailed: 150,
			sampledAssertionsFailed: 4,
			elementsErrored: 3,
			teardownsFailed: 1,
		},
		{
			outcome: "not-judged",
			reason: "All 3 budgets met, but 0.4% errors, 150 assertions failed, 4 more in the sampled replay, 3 elements errored, 1 teardown script failed",
		},
	],
	[
		"zero errored elements and teardowns change nothing",
		{
			status: "completed",
			thresholdValidation: THREE_MET,
			errorRate: 0,
			elementsErrored: 0,
			teardownsFailed: 0,
		},
		{ outcome: "passed", reason: "All 3 budgets met" },
	],
	[
		"a missed budget stays failed over errored elements and teardowns",
		{
			status: "completed",
			thresholdValidation: TWO_OF_FOUR_MISSED,
			elementsErrored: 3,
			teardownsFailed: 1,
		},
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

/*
 * A collection run's notification and spoken ending (#3539). Mutation check:
 * answer the failed reason for met budgets too and the null cases redden;
 * word it apart from `judgeRun` and the agreement case does.
 */
describe("missedBudgetsReason", () => {
	it("names what a budget block missed", () => {
		expect(missedBudgetsReason(TWO_OF_FOUR_MISSED)).toBe(
			"2 of 4 budgets missed: p95, throughput"
		);
	});

	it("says it in the failed verdict's words", () => {
		const judged = judgeRun({ status: "completed", thresholdValidation: TWO_OF_FOUR_MISSED });
		expect(missedBudgetsReason(TWO_OF_FOUR_MISSED)).toBe(judged?.reason);
	});

	it.each([
		["every budget met", THREE_MET],
		["no budget declared", { checks: [], passed: 0, failed: 0, verdict: "passed" } as Budgets],
		["no block", null],
		["an absent block", undefined],
	])("is null for %s", (_name, block) => {
		expect(missedBudgetsReason(block)).toBeNull();
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

	// #3537: the report's top-level block, the same for both run kinds.
	it("names a scenario run's sampled replay when its exact block is clean", () => {
		const scenario = report({
			thresholdValidation: THREE_MET,
			scenario: { assertions: { passed: 10, failed: 0 } },
			testValidation: { samplesTested: 23, testsPassed: 0, testsFailed: 23, successRate: 0 },
			assertions: {
				exact: { passed: 10, failed: 0 },
				sampled: { passed: 0, failed: 23 },
				errored: 0,
				teardownFailed: 0,
			},
		} as Partial<RunReport>);
		expect(reportOutcome(scenario)).toEqual({
			outcome: "not-judged",
			reason: "All 3 budgets met, but 23 assertions failed in the sampled replay",
		});
	});

	it("reads the block over a single-request report's own fields", () => {
		const block = report({
			thresholdValidation: THREE_MET,
			elements: [{ id: "t", kind: "extract.json", passed: 0, failed: 0, skipped: 0 }],
			assertions: { exact: { passed: 0, failed: 4227 }, sampled: { passed: 0, failed: 0 } },
		} as Partial<RunReport>);
		expect(reportOutcome(block)?.reason).toBe("All 3 budgets met, but 4,227 assertions failed");
	});

	it.each([
		["an errored element", { errored: 3 }, "All 3 budgets met, but 3 elements errored"],
		[
			"a failed teardown",
			{ teardownFailed: 1 },
			"All 3 budgets met, but 1 teardown script failed",
		],
	])("is not a pass for %s alone", (_name, assertions, reason) => {
		const judged = reportOutcome(report({ thresholdValidation: THREE_MET, assertions }));
		expect(judged).toEqual({ outcome: "not-judged", reason });
	});

	it("names errored elements and failed teardowns with no budgets", () => {
		const judged = reportOutcome(report({ assertions: { errored: 2202, teardownFailed: 1 } }));
		expect(judged?.reason).toBe(
			"No budgets set. 0.0% errors, 2,202 elements errored, 1 teardown script failed"
		);
	});

	// #3538: `summary.drainCut`, read for every report kind.
	describe("a drain a Stop cut", () => {
		const cut = (cancelled: unknown) =>
			({
				summary: {
					totalRequests: 285,
					successfulRequests: 285,
					failedRequests: 0,
					errorRate: 0,
					drainCut: { cancelled },
				},
			}) as Partial<RunReport>;

		it("leaves a run that met its budgets not judged, naming the unanswered requests", () => {
			expect(reportOutcome(report({ thresholdValidation: THREE_MET, ...cut(15) }))).toEqual({
				outcome: "not-judged",
				reason: "15 requests were still unanswered when the drain was stopped",
			});
		});

		it("is singular for one request", () => {
			expect(reportOutcome(report(cut(1)))?.reason).toBe(
				"1 request was still unanswered when the drain was stopped"
			);
		});

		it("does not append the run's failed checks", () => {
			const failedChecks = report({
				thresholdValidation: THREE_MET,
				assertions: { exact: { passed: 0, failed: 9 }, errored: 2 },
				...cut(15),
			} as Partial<RunReport>);
			expect(reportOutcome(failedChecks)?.reason).toBe(
				"15 requests were still unanswered when the drain was stopped"
			);
		});

		it.each([
			["a missed budget", { thresholdValidation: TWO_OF_FOUR_MISSED }, "failed"],
			["a failed status", { status: "failed" }, "failed"],
			["a stopped status", { status: "stopped" }, "not-judged"],
		])("loses to %s", (_name, overrides, outcome) => {
			const judged = reportOutcome(
				report({ ...overrides, ...cut(15) } as Partial<RunReport>)
			);
			expect(judged?.outcome).toBe(outcome);
			expect(judged?.reason).not.toMatch(/drain/);
		});

		it.each([
			["zero", 0],
			["negative", -3],
			["fractional", 1.5],
			["a string", "15"],
			["null", null],
		])("ignores a count that is %s", (_name, cancelled) => {
			expect(
				reportOutcome(report({ thresholdValidation: THREE_MET, ...cut(cancelled) }))
			).toEqual({ outcome: "passed", reason: "All 3 budgets met" });
		});

		it("ignores a drainCut that is not a block", () => {
			const malformed = report({
				thresholdValidation: THREE_MET,
				summary: { totalRequests: 100, errorRate: 0, drainCut: 15 },
			} as unknown as Partial<RunReport>);
			expect(reportOutcome(malformed)?.outcome).toBe("passed");
		});
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

	// #3537: a row's block names which population failed, and what else did.
	it("names a row's sampled replay from its block, not its summed flat count", () => {
		expect(
			rowOutcome(
				row({
					resultSummary: {
						errorRate: 0,
						verdict: "passed",
						assertions: {
							exact: { passed: 4400, failed: 0 },
							sampled: { passed: 0, failed: 91 },
							errored: 0,
							teardownFailed: 0,
						},
						assertionsPassed: 4400,
						assertionsFailed: 91,
					},
				})
			)
		).toEqual({
			outcome: "not-judged",
			reason: "All budgets met, but 91 assertions failed in the sampled replay",
		});
	});

	it("is not a pass for a row whose elements errored and whose assertions held", () => {
		expect(
			rowOutcome(
				row({
					resultSummary: {
						errorRate: 0,
						verdict: "passed",
						assertions: {
							exact: { passed: 0, failed: 0 },
							sampled: { passed: 0, failed: 0 },
							errored: 2202,
							teardownFailed: 1,
						},
						assertionsPassed: 0,
						assertionsFailed: 0,
					},
				})
			)
		).toEqual({
			outcome: "not-judged",
			reason: "All budgets met, but 2,202 elements errored, 1 teardown script failed",
		});
	});

	// #3538: the row's own `resultSummary.drainCut`, the same verdict as the report's.
	describe("a drain a Stop cut", () => {
		const cut = (cancelled: number) => ({ drainCut: { cancelled } });

		it("leaves a row whose budgets passed not judged", () => {
			expect(
				rowOutcome(row({ resultSummary: { errorRate: 0, verdict: "passed", ...cut(15) } }))
			).toEqual({
				outcome: "not-judged",
				reason: "15 requests were still unanswered when the drain was stopped",
			});
		});

		it("is singular for one request, and replaces the row's failed assertions", () => {
			expect(
				rowOutcome(
					row({
						resultSummary: {
							errorRate: 0,
							verdict: "passed",
							assertionsFailed: 4,
							...cut(1),
						},
					})
				)?.reason
			).toBe("1 request was still unanswered when the drain was stopped");
		});

		it.each([
			["a failed verdict", { status: "completed", verdict: "failed" }, "failed"],
			["a failed status", { status: "failed", verdict: "passed" }, "failed"],
			["a stopped status", { status: "stopped", verdict: "passed" }, "not-judged"],
		])("loses to %s", (_name, { status, verdict }, outcome) => {
			const judged = rowOutcome(
				row({
					status: status as Run["status"],
					resultSummary: {
						errorRate: 0,
						verdict: verdict as "passed" | "failed",
						...cut(15),
					},
				})
			);
			expect(judged?.outcome).toBe(outcome);
			expect(judged?.reason).not.toMatch(/drain/);
		});
	});

	it("says nothing for a load row with no summary, so the status glyph stays", () => {
		expect(rowOutcome(row({}))).toBeNull();
	});

	it("says nothing for a design row that did not fail, whatever it carries", () => {
		expect(
			rowOutcome(row({ type: "design", resultSummary: { statusCode: 500, latencyMs: 3 } }))
		).toBeNull();
	});

	// #3643: the status is the verdict of a failed run, so no summary - and no run
	// type - can leave it without one.
	describe("a row whose status is failed", () => {
		const SUMMARY_FREE_REASON = "The run failed before it finished";

		it.each<[string, Partial<Run>]>([
			["a load row with no summary", { type: "load" }],
			["a load row with an empty summary", { type: "load", resultSummary: {} }],
			["a scenario row with no summary", { type: "scenario" }],
			["a design row with no summary", { type: "design" }],
			[
				"a design row with a result",
				{ type: "design", resultSummary: { statusCode: 500, latencyMs: 3 } },
			],
			[
				"a scenario row whose counts are clean",
				{ type: "scenario", resultSummary: { passed: 3 } },
			],
		])("is failed for %s", (_name, over) => {
			expect(rowOutcome(row({ ...over, status: "failed" }))).toEqual({
				outcome: "failed",
				reason: SUMMARY_FREE_REASON,
			});
		});

		it.each<[string, Partial<Run>]>([
			["a load row", { type: "load", resultSummary: { verdict: "failed" } }],
			["a scenario row", { type: "scenario", resultSummary: { verdict: "failed" } }],
		])("keeps the missed-budget reason of %s", (_name, over) => {
			expect(rowOutcome(row({ ...over, status: "failed" }))).toEqual({
				outcome: "failed",
				reason: "Budgets missed",
			});
		});

		it("stays failed whatever the summary would have judged", () => {
			expect(
				rowOutcome(
					row({
						status: "failed",
						resultSummary: { errorRate: 0, verdict: "passed" },
					})
				)?.outcome
			).toBe("failed");
		});

		it("is stored as failed, so the outcome filter lists it", () => {
			expect(rowStoredOutcome(row({ type: "design", status: "failed" }))).toBe("failed");
		});

		it("derives failed for a row stored before the column, and defers to a stored outcome", () => {
			const legacy = row({ type: "load", status: "failed" });
			expect(legacy.outcome).toBeUndefined();
			expect(rowOutcome(legacy)?.outcome).toBe("failed");
			expect(rowOutcome({ ...legacy, outcome: "failed" })?.reason).toBe(
				"The run failed before it finished"
			);
		});
	});

	// #3458: a collection row is failed when a step failed or errored; #3539: or
	// when it missed a budget.
	describe("a collection row", () => {
		function collection(
			resultSummary: Extract<Run, { type: "scenario" }>["resultSummary"],
			status: Run["status"] = "completed"
		): Run {
			return row({ type: "scenario", status, resultSummary });
		}

		it.each([
			["a failed step", { passed: 3, failed: 1 }, "1 failed"],
			["an errored step", { passed: 3, errored: 2 }, "2 errored"],
			["both", { passed: 2, failed: 1, errored: 4, skipped: 5 }, "1 failed, 4 errored"],
		])("is failed for %s", (_name, resultSummary, reason) => {
			expect(rowOutcome(collection(resultSummary))).toEqual({ outcome: "failed", reason });
		});

		it.each([
			[
				"a missed budget over clean steps",
				{ passed: 3, verdict: "failed" },
				"Budgets missed",
			],
			[
				"a missed budget beside a failed step",
				{ passed: 3, failed: 1, verdict: "failed" },
				"Budgets missed, 1 failed",
			],
			[
				"a missed budget beside failed and errored steps",
				{ passed: 2, failed: 1, errored: 4, verdict: "failed" },
				"Budgets missed, 1 failed, 4 errored",
			],
			["a missed budget and nothing else recorded", { verdict: "failed" }, "Budgets missed"],
		] as const)("is failed for %s", (_name, resultSummary, reason) => {
			expect(rowOutcome(collection(resultSummary))).toEqual({ outcome: "failed", reason });
		});

		it("keeps a failed step's reason when the budgets were met", () => {
			expect(rowOutcome(collection({ passed: 3, failed: 1, verdict: "passed" }))).toEqual({
				outcome: "failed",
				reason: "1 failed",
			});
		});

		it.each([
			["only passed and skipped steps", { passed: 3, skipped: 1 }],
			["zeroed failure counts", { passed: 3, failed: 0, errored: 0 }],
			["a step stopped by the user", { passed: 1, stopped: 2 }],
			// The success tick of a met-budget clean run stays: `null` keeps the status glyph.
			["met budgets over clean steps", { passed: 3, verdict: "passed" }],
		] as const)("keeps its status glyph for %s", (_name, resultSummary) => {
			expect(rowOutcome(collection(resultSummary))).toBeNull();
		});

		it("says nothing for a row with no summary or a run that did not complete", () => {
			expect(rowOutcome(row({ type: "scenario" }))).toBeNull();
			expect(rowOutcome(collection({ failed: 2 }, "stopped"))).toBeNull();
			expect(rowOutcome(collection({ passed: 3, verdict: "failed" }, "stopped"))).toBeNull();
		});
	});
});

/**
 * An opened collection run's pill (#3543) and its list row are the same run
 * read from two payloads, so they answer from one core: the same verdict for the
 * same steps and the same budget miss. The report names the missed budgets,
 * which the row cannot, so a miss reads differently in its reason only.
 */
describe("collectionReportOutcome", () => {
	type Counts = { passed: number; failed: number; skipped: number; errored: number };
	const CLEAN: Counts = { passed: 3, failed: 0, skipped: 0, errored: 0 };

	function collectionReport(
		counts: Partial<Counts> | undefined,
		over: { status?: string; thresholdValidation?: Budgets } = {}
	): RunReport {
		const { status = "completed", thresholdValidation } = over;
		return {
			metadata: { runId: "run_1", runType: "scenario", status, startTime: 0, endTime: 1 },
			summary: { totalRequests: 4, successfulRequests: 4, failedRequests: 0, errorRate: 0 },
			...(counts ? { scenario: { ...CLEAN, ...counts } } : {}),
			...(thresholdValidation ? { thresholdValidation } : {}),
		} as unknown as RunReport;
	}

	it.each([
		["a failed step", { failed: 1 }, "1 failed"],
		["an errored step", { errored: 2 }, "2 errored"],
		["failed and errored steps", { failed: 1, errored: 4, skipped: 5 }, "1 failed, 4 errored"],
	])("is failed for %s", (_name, counts, reason) => {
		expect(collectionReportOutcome(collectionReport(counts))).toEqual({
			outcome: "failed",
			reason,
		});
	});

	it("is failed for a missed budget over clean steps, naming it", () => {
		const missed = budgets(["latencyP99Ms", false], ["latencyP95Ms", true]);
		expect(
			collectionReportOutcome(collectionReport({}, { thresholdValidation: missed }))
		).toEqual({ outcome: "failed", reason: "1 of 2 budgets missed: p99" });
	});

	it("names a missed budget before the failed steps, as the row does", () => {
		const missed = budgets(["latencyP99Ms", false]);
		expect(
			collectionReportOutcome(
				collectionReport({ failed: 1 }, { thresholdValidation: missed })
			)
		).toEqual({ outcome: "failed", reason: "1 of 1 budget missed: p99, 1 failed" });
	});

	it.each([
		["clean steps and no budgets", collectionReport({})],
		["clean steps and met budgets", collectionReport({}, { thresholdValidation: THREE_MET })],
		["a step the user stopped", collectionReport({ stopped: 2 } as Partial<Counts>)],
		["a run that did not complete", collectionReport({ failed: 2 }, { status: "stopped" })],
		[
			"a run that failed before it finished",
			collectionReport({ failed: 2 }, { status: "failed" }),
		],
		["a report with no step counts", collectionReport(undefined)],
		["a report with no status", collectionReport({ failed: 1 }, { status: "" })],
	])("keeps the status glyph for %s", (_name, report) => {
		expect(collectionReportOutcome(report)).toBeNull();
	});

	it("says nothing for a missing report", () => {
		expect(collectionReportOutcome(undefined)).toBeNull();
		expect(collectionReportOutcome(null)).toBeNull();
	});

	// The same run through both payloads: the verdict agrees, and the reason does
	// too wherever the row has the words to say it (it has no budget names).
	it.each([
		["clean", {}, undefined],
		["a failed step", { failed: 1 }, undefined],
		["an errored step", { errored: 2 }, undefined],
		["a missed budget", {}, budgets(["latencyP99Ms", false])],
		["a missed budget and a failed step", { failed: 1 }, budgets(["latencyP99Ms", false])],
		["met budgets and an errored step", { errored: 1 }, THREE_MET],
		["met budgets over clean steps", {}, THREE_MET],
	] as Array<[string, Partial<Counts>, Budgets | undefined]>)(
		"agrees with the list row for %s",
		(_name, counts, thresholdValidation) => {
			const failedBudget = thresholdValidation?.failed ? 1 : 0;
			const verdict = thresholdValidation
				? failedBudget > 0
					? "failed"
					: "passed"
				: undefined;
			const fromRow = rowOutcome(
				row({
					type: "scenario",
					status: "completed",
					resultSummary: { ...CLEAN, ...counts, ...(verdict ? { verdict } : {}) },
				})
			);
			const fromReport = collectionReportOutcome(
				collectionReport(counts, { thresholdValidation })
			);
			expect(fromReport?.outcome).toBe(fromRow?.outcome);
			if (failedBudget === 0) expect(fromReport).toEqual(fromRow);
		}
	);
});

/**
 * The engine's run-report export and this verdict answer one table (#3537):
 * `run-verdict-conformance.json`, whose engine half is `run_export_test.cpp`.
 * The app exposes no reason code, so the code is read off the judgement: the
 * fixed sentences, the outcome, and for met budgets the first clause after
 * "but", which is the first thing that undercut them.
 */
describe("run verdict conformance", () => {
	interface VerdictCase {
		name: string;
		report: RunReport;
		expected: { state: "passed" | "failed" | "not_judged"; reason: string; names?: string[] };
	}

	const [fixturePath] = ENGINE_READING_GUARDS.runVerdict.paths.map(fromRepoRoot);
	const CASES = (JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: VerdictCase[] }).cases;

	const UNDERCUT_CODES: ReadonlyArray<[pattern: RegExp, code: string]> = [
		[/^\S+% errors/, "budgets_met_with_errors"],
		[/^\S+ assertions? failed/, "budgets_met_with_assertion_failures"],
		[/^\S+ elements? errored/, "budgets_met_with_element_errors"],
		[/^\S+ teardown scripts? failed/, "budgets_met_with_teardown_failures"],
	];

	function reasonCodeOf({ outcome, reason }: RunJudgement): string | undefined {
		if (reason === "Stopped before it finished") return "stopped";
		if (reason === "The run failed before it finished") return "run_failed";
		if (/ still unanswered when the drain was stopped$/.test(reason)) return "drain_stopped";
		if (outcome === "failed") return "budgets_missed";
		if (reason.startsWith("No budgets set")) return "no_budgets";
		if (outcome === "passed") return "budgets_met";
		const undercut = reason.split(", but ")[1] ?? "";
		return UNDERCUT_CODES.find(([pattern]) => pattern.test(undercut))?.[1];
	}

	/** Each of @p names in @p reason, in order, or the first one missing. */
	function missingName(reason: string, names: string[]): string | undefined {
		let from = 0;
		for (const name of names) {
			const at = reason.indexOf(name, from);
			if (at < 0) return name;
			from = at + name.length;
		}
		return undefined;
	}

	const FAILED_CHECK = /assertions? failed|elements? errored|teardown scripts? failed/;

	it("replays every case of the fixture", () => {
		expect(CASES.length).toBeGreaterThanOrEqual(29);
	});

	it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, { report, expected }) => {
		const judged = reportOutcome(report);
		expect(judged).not.toBeNull();
		if (!judged) return;
		expect(judged.outcome).toBe(
			expected.state === "not_judged" ? "not-judged" : expected.state
		);
		expect(reasonCodeOf(judged)).toBe(expected.reason);
		if (expected.names) {
			expect(missingName(judged.reason, expected.names)).toBeUndefined();
		} else {
			expect(judged.reason).not.toMatch(FAILED_CHECK);
		}
	});
});

/**
 * The verdict the engine stores on a row and the one `rowOutcome` derives from
 * the same row are one rule (#3547): `run-row-outcome-conformance.json`, whose
 * engine half is `run_result_summary_test.cpp`. Each case is built without an
 * `outcome`, so the renderer's derivation is what answers.
 */
describe("row outcome conformance", () => {
	interface RowCase {
		name: string;
		type: Run["type"];
		status: Run["status"];
		resultSummary?: Run["resultSummary"];
		expected: "passed" | "failed" | "not_judged" | null;
	}

	const [fixturePath] = ENGINE_READING_GUARDS.runRowOutcome.paths.map(fromRepoRoot);
	const CASES = (JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: RowCase[] }).cases;

	it("replays every case of the fixture", () => {
		expect(CASES.length).toBeGreaterThanOrEqual(33);
	});

	it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const derived = row({
			type: c.type,
			status: c.status,
			resultSummary: c.resultSummary,
		} as Partial<Run>);
		expect(rowStoredOutcome(derived)).toBe(c.expected);
	});
});

describe("verdictBesideStatus", () => {
	const judged = (outcome: RunOutcome) => ({ outcome, reason: "x" });

	it("says the verdict a status word does not already say", () => {
		expect(verdictBesideStatus("completed", judged("failed"))).toBe("failed");
		expect(verdictBesideStatus("completed", judged("not-judged"))).toBe("not judged");
		expect(verdictBesideStatus("completed", judged("passed"))).toBe("passed");
		expect(verdictBesideStatus("stopped", judged("not-judged"))).toBe("not judged");
	});

	it("is silent beside a failed status, which is the verdict", () => {
		expect(verdictBesideStatus("failed", judged("failed"))).toBeNull();
	});

	it("is silent when there is no verdict", () => {
		expect(verdictBesideStatus("completed", null)).toBeNull();
		expect(verdictBesideStatus("failed", null)).toBeNull();
	});
});

describe("rowOutcome with a stored outcome", () => {
	const MISSED = { rps: 485, errorRate: 0, verdict: "failed" } as const;

	it("keeps the derived reason when the stored category agrees", () => {
		expect(rowOutcome(row({ outcome: "failed", resultSummary: MISSED }))).toEqual({
			outcome: "failed",
			reason: "Budgets missed",
		});
	});

	it("lets the stored outcome win over a derivation that says otherwise", () => {
		const judged = rowOutcome(row({ outcome: "not_judged", resultSummary: MISSED }));
		expect(judged?.outcome).toBe("not-judged");
		expect(judged?.reason).toBe("Judged by Vayu's engine");
	});

	it("reads a stored not_judged as the renderer's not-judged", () => {
		expect(
			rowOutcome(row({ outcome: "not_judged", resultSummary: { rps: 40 } }))?.outcome
		).toBe("not-judged");
	});

	it("judges a row its summary cannot, when the engine stored a verdict", () => {
		expect(rowOutcome(row({ outcome: "passed" }))).toEqual({
			outcome: "passed",
			reason: "Judged by Vayu's engine",
		});
	});

	it("derives from the summary when no outcome was stored", () => {
		expect(rowOutcome(row({ resultSummary: MISSED }))?.outcome).toBe("failed");
		expect(rowOutcome(row({}))).toBeNull();
	});
});
