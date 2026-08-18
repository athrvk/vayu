/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A load run's per-test failures, as data (issue #726).
 *
 * The engine records them on a **synthetic result row** rather than a captured
 * request: `run_manager.cpp` appends one `Result` whose `trace_data` is
 * `{failures[], totalFailed, totalPassed}`, with `statusCode 0` and the error
 * "Script validation failures". It rides in `report.results` beside the real
 * samples, and `trace.failures` is the only field that tells the two apart - no
 * captured request ever carries it.
 *
 * The live dashboard reads that row inline, per sample. History does not: its
 * Samples tab would render the row as a status-0 card with no request behind it
 * (a "junk sample"), so this module lifts the failures out for the Overview to
 * name and lets the Samples tab drop the row. Pure, so the split and the
 * extraction are pinned without a DOM.
 */

import type { SampleResult } from "../types";

/** The named per-test failures a run recorded, lifted off the synthetic row. */
export interface TestFailures {
	/** The failure lines, bounded engine-side; {@link total} is the real count. */
	messages: string[];
	total: number;
	passed: number;
}

/**
 * Whether this result is the synthetic test-validation row rather than a
 * captured request. `trace.failures` is present on that row alone, so its
 * presence - not the status-0 code, which a real connection failure also uses -
 * is what identifies it.
 */
export function isTestValidationRow(result: SampleResult): boolean {
	return result.trace?.failures !== undefined;
}

/**
 * The run's named failures, or `null` when it recorded none (every assertion
 * passed, or the run asserted nothing). `total` falls back to the list length
 * for a row that predates the count, never to zero, so a truncated list is not
 * quietly reported as complete.
 */
export function extractTestFailures(results: SampleResult[] | undefined): TestFailures | null {
	const row = results?.find(isTestValidationRow);
	const messages = row?.trace?.failures;
	if (!messages || messages.length === 0) return null;
	return {
		messages,
		total: row?.trace?.totalFailed ?? messages.length,
		passed: row?.trace?.totalPassed ?? 0,
	};
}

/**
 * The captured samples only - the synthetic failure row removed, so the Samples
 * tab never renders it as a request that was never sent.
 */
export function sampleResultsWithoutValidationRow(
	results: SampleResult[] | undefined
): SampleResult[] {
	if (!results) return [];
	return results.filter((r) => !isTestValidationRow(r));
}
