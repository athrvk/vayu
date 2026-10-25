/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunReport } from "@/types";

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
