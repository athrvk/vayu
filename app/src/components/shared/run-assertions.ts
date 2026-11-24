/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type {
	AssertionPopulation,
	LoadResultSummary,
	RunAssertions,
	RunReport,
	RunScenarioStepElementTally,
	RunScenarioStepStat,
} from "@/types";

export type ExactAssertions = AssertionPopulation;

/** The report fields a run's assertion block is read from, or derived from before #3537. */
type AssertionSources = Pick<RunReport, "assertions" | "scenario" | "elements" | "testValidation">;

/**
 * A load run's assertion block (#3537): the report's `assertions`, or what an older engine's fields
 * said. A scenario run's `scenario.assertions` is `exact` alone, its sampled replay unread; a
 * single-request run's top-level `elements` failures are `exact` and its `testValidation` `sampled`
 * (#3458). Neither derives `errored` or `teardownFailed`, so an old report keeps its verdict;
 * `undefined` when the report states none. The one read of the block: the verdict
 * (`reportOutcome`), the key-metrics tile and the Overview's Assertions card (`exactAssertionsOf`)
 * all use it, so a pill and a tile cannot come from two fields.
 */
export function reportAssertionsOf(report: AssertionSources): RunAssertions | undefined {
	if (report.assertions) return report.assertions;
	if (report.scenario) {
		const exact = report.scenario.assertions;
		return exact ? { exact } : undefined;
	}
	return singleRequestAssertionsBeforeBlock(report);
}

function singleRequestAssertionsBeforeBlock({
	elements,
	testValidation,
}: AssertionSources): RunAssertions | undefined {
	if (!elements && !testValidation) return undefined;
	const block: RunAssertions = {};
	if (elements) {
		block.exact = elements.reduce(
			(total, element) => ({
				passed: total.passed + element.passed,
				failed: total.failed + element.failed,
			}),
			{ passed: 0, failed: 0 }
		);
	}
	if (testValidation) {
		block.sampled = { passed: testValidation.testsPassed, failed: testValidation.testsFailed };
	}
	return block;
}

/**
 * The list row's assertion block (#3537), the row twin of {@link reportAssertionsOf}; an older
 * row's flat `assertionsFailed` reads as `exact`, the reading it had, as it could not name a
 * population.
 */
export function rowAssertionsOf(summary: LoadResultSummary): RunAssertions | undefined {
	if (summary.assertions) return summary.assertions;
	if (summary.assertionsFailed === undefined) return undefined;
	return { exact: { passed: summary.assertionsPassed ?? 0, failed: summary.assertionsFailed } };
}

/**
 * A scenario load run's exact assertion population (#2820), or `undefined` when it made none (no
 * `assert.*`, no required `extract.*`, no inline `pm.test`), for a collection run and for a report
 * stored before the field. A single-request run answers `undefined` too, so the cards draw no
 * Assertions block, its exact tallies being the Overview's element rows. The block's `exact` is
 * written at zero; the card is not.
 */
export function exactAssertionsOf(
	report: Pick<RunReport, "assertions" | "scenario"> | null | undefined
): ExactAssertions | undefined {
	if (!report?.scenario) return undefined;
	const exact = reportAssertionsOf(report)?.exact;
	return exact && exact.passed + exact.failed > 0 ? exact : undefined;
}

/** `3 elements errored` for a positive @p count of @p noun, or `null`. */
function countedPhrase(count: number | undefined, noun: string, verb: string): string | null {
	if (count === undefined || count <= 0) return null;
	return `${formatNumber(count)} ${pluralize(count, noun)} ${verb}`;
}

/** `4,580 assertions failed`, or `null` when none did - the phrase a row line and a verdict reason share. */
export function assertionsFailedPhrase(failed: number | undefined): string | null {
	return countedPhrase(failed, "assertion", "failed");
}

/**
 * A load run's failed checks by kind, what keeps met budgets from reading passed (#3537); the two
 * assertion populations stay apart, as the reason must say which failed (#3458).
 */
export interface FailedChecks {
	/** Every response: `assertions.exact.failed`. */
	assertionsFailed: number;
	/** Only the responses the post-run replay was drawn over: `assertions.sampled.failed`. */
	sampledAssertionsFailed: number;
	/** Element executions that ended in error. */
	elementsErrored: number;
	/** Teardown scripts that failed or errored. */
	teardownsFailed: number;
}

/** The failed checks an assertion block counts; every count `0` when there is no block. */
export function failedChecksOf(assertions: RunAssertions | undefined): FailedChecks {
	return {
		assertionsFailed: assertions?.exact?.failed ?? 0,
		sampledAssertionsFailed: assertions?.sampled?.failed ?? 0,
		elementsErrored: assertions?.errored ?? 0,
		teardownsFailed: assertions?.teardownFailed ?? 0,
	};
}

/**
 * Why a run that met its budgets is not a pass, for failed assertions: `150 assertions failed`,
 * `4 assertions failed in the sampled replay`, or both; `null` when none failed.
 */
export function failedAssertionsReason(
	exact: number | undefined,
	sampled: number | undefined
): string | null {
	const exactPhrase = assertionsFailedPhrase(exact);
	const sampledPhrase = assertionsFailedPhrase(sampled);
	if (!sampledPhrase) return exactPhrase;
	if (!exactPhrase) return `${sampledPhrase} in the sampled replay`;
	return `${exactPhrase}, ${formatNumber(sampled)} more in the sampled replay`;
}

/**
 * Every failed check, worded, in the verdict's order: assertions, then `3 elements errored`, then
 * `1 teardown script failed`. The run-report export's verdict line words them alike
 * (`failed_checks_text`, `engine/src/core/run_export_view.cpp`), held by
 * `engine/tests/fixtures/run-verdict-conformance.json`. Empty when none failed.
 */
export function failedCheckPhrases(checks: Partial<FailedChecks>): string[] {
	const phrases = [
		failedAssertionsReason(checks.assertionsFailed, checks.sampledAssertionsFailed),
		countedPhrase(checks.elementsErrored, "element", "errored"),
		countedPhrase(checks.teardownsFailed, "teardown script", "failed"),
	];
	return phrases.filter((phrase): phrase is string => phrase !== null);
}

export const TEST_VALIDATION_TITLE = "Test validation";
export const SAMPLED_REPLAY_TITLE = "Sampled replay";

/**
 * What the sampled-replay card is called on this report: a run also showing exact assertions
 * (#2820) retitles it, so the two are never both "Test validation"; pointers at the card
 * (`ElementTally`'s deferred row) ask here, naming a card that exists.
 */
export function testValidationTitleOf(
	report: Pick<RunReport, "assertions" | "scenario"> | null | undefined
): string {
	return exactAssertionsOf(report) ? SAMPLED_REPLAY_TITLE : TEST_VALIDATION_TITLE;
}

/**
 * The responses a step's deferred post-request scripts were left to replay (`script.*` elements'
 * `deferred`, summed); zero without any, and for a report predating #2144, which tallied the
 * replayed script as `skipped`.
 */
export function deferredResponsesOf(step: Pick<RunScenarioStepStat, "elements">): number {
	let total = 0;
	for (const element of step.elements ?? []) {
		if (element.kind.startsWith("script.")) total += element.deferred ?? 0;
	}
	return total;
}

/** `post-run replay over 1,000 sampled responses`, or the unsized phrase. */
export function replayPhrase(samples: number | undefined): string {
	if (samples === undefined) return "post-run replay of sampled responses";
	return `post-run replay over ${formatNumber(samples)} sampled ${pluralize(samples, "response")}`;
}

/** Whether a replay said anything to the console: a line, or a count of lines a full list turned away (#3127). */
export function hasReplayConsole(
	source: Pick<RunScenarioStepElementTally, "console" | "consoleDropped"> | undefined
): boolean {
	if (!source) return false;
	return (source.console?.length ?? 0) > 0 || (source.consoleDropped ?? 0) > 0;
}

/** The population the sampled replay was drawn from, in a scenario load run. */
export interface ReplayScope {
	/** Responses that carried a deferred test script, across every step. */
	responses: number;
	/** Steps that carried one. */
	steps: number;
	/** The Assertions card (#2820) renders beside the replay, so a sentence can point at it. */
	assertionsCounted: boolean;
}

/**
 * What the sampled replay sampled, or `undefined` outside a scenario load run or when no step
 * deferred a script (#2824): the request total is the wrong denominator there, as most of a
 * sequence's requests carry no test script.
 */
export function replayScopeOf(
	report: Pick<RunReport, "assertions" | "scenario"> | null | undefined
): ReplayScope | undefined {
	const steps = report?.scenario?.steps ?? [];
	let responses = 0;
	let carrying = 0;
	for (const step of steps) {
		const deferred = deferredResponsesOf(step);
		responses += deferred;
		if (deferred > 0) carrying += 1;
	}
	if (responses === 0) return undefined;
	return { responses, steps: carrying, assertionsCounted: !!exactAssertionsOf(report) };
}
