/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunReport, RunScenarioStepElementTally, RunScenarioStepStat } from "@/types";

export type ExactAssertions = NonNullable<NonNullable<RunReport["scenario"]>["assertions"]>;

/**
 * A scenario load run's exact assertion population (#2820), or `undefined` when
 * the run made none: no `assert.*` element, no required `extract.*` and no
 * inline `pm.test`, or a collection run, or a report stored before the field.
 *
 * The one read of `scenario.assertions`: the key-metrics tile, the Overview's
 * Assertions block and the run's verdict (`reportOutcome`) all go through it,
 * so what a pill says and what a tile says cannot come from two fields.
 */
export function exactAssertionsOf(
	report: Pick<RunReport, "scenario"> | null | undefined
): ExactAssertions | undefined {
	return report?.scenario?.assertions;
}

/** `4,580 assertions failed`, or `null` when none did - the phrase a row line and a verdict reason share. */
export function assertionsFailedPhrase(failed: number | undefined): string | null {
	if (failed === undefined || failed <= 0) return null;
	return `${formatNumber(failed)} ${pluralize(failed, "assertion")} failed`;
}

/** A load run's failed assertions, split by how they were counted. */
export interface FailedAssertions {
	/** Every response: a scenario's `assertions`, or a single request's inline `elements`. */
	exact: number;
	/** Only the responses the post-run replay was drawn over (`testValidation`). */
	sampled: number;
}

/**
 * The failed assertions a report states, kept as two populations because the
 * verdict's wording has to say which one it is (#3458).
 *
 * A scenario run's exact count is `scenario.assertions`. A single-request run
 * has no `scenario`: its exact tallies are the failed counts of the top-level
 * `elements` and its sampled ones `testValidation.testsFailed`. The two never
 * overlap - a script that ran inline is tallied in its element row and skipped
 * by the replay, one that did not is `deferred` there and counted by the replay
 * alone - so summing within a population is safe and across them is not done.
 * `exactAssertionsOf` stays the card-facing read: it answers `undefined` for a
 * single-request run, which is how the cards know there is no Assertions block.
 */
export function failedAssertionsOf(
	report: Pick<RunReport, "scenario" | "elements" | "testValidation">
): FailedAssertions {
	if (report.scenario) return { exact: exactAssertionsOf(report)?.failed ?? 0, sampled: 0 };
	const exact = (report.elements ?? []).reduce((total, element) => total + element.failed, 0);
	return { exact, sampled: report.testValidation?.testsFailed ?? 0 };
}

/**
 * Why a run that met its budgets is still not a pass, for failed assertions:
 * `150 assertions failed`, `4 assertions failed in the sampled replay`, or both.
 * `null` when none failed.
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

export const TEST_VALIDATION_TITLE = "Test validation";
export const SAMPLED_REPLAY_TITLE = "Sampled replay";

/**
 * What the sampled-replay card is called on this report. A run that also shows
 * the exact assertions (#2820) retitles it, so the two populations are never
 * both "Test validation"; every pointer at the card (`ElementTally`'s deferred
 * row) asks here too, so the pointer names a card that exists.
 */
export function testValidationTitleOf(
	report: Pick<RunReport, "scenario"> | null | undefined
): string {
	return exactAssertionsOf(report) ? SAMPLED_REPLAY_TITLE : TEST_VALIDATION_TITLE;
}

/**
 * The responses a step's deferred post-request scripts were left to replay
 * (`script.*` elements' `deferred`, summed). Zero for a step with none, and for
 * a report stored before #2144, which tallied the replayed script as `skipped`.
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
 * What the sampled replay was a sample *of*, or `undefined` when the report is
 * not a scenario load run or no step deferred a script (#2824). The request
 * total is the wrong denominator there: most requests of a sequence carry no
 * test script at all, so they are not "not kept".
 */
export function replayScopeOf(
	report: Pick<RunReport, "scenario"> | null | undefined
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
