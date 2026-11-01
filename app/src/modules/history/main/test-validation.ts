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
 * `{failures[], failureCounts[], failuresDistinct, totalFailed, totalPassed}`
 * (#3127: each distinct message once, with how often it failed;
 * `totalFailed` and `totalPassed` count every occurrence), with `statusCode 0` and the error "Script validation
 * failures". It rides in `report.results` beside the real samples, and
 * `trace.failures` is the only field that tells the two apart - no captured
 * request ever carries it.
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
	/** The distinct failure lines, bounded engine-side; {@link distinct} is how many there were. */
	messages: string[];
	/** How many times each of {@link messages} failed, parallel to it; 1 each on an old row. */
	counts: number[];
	/** Failed assertions, each occurrence counted. */
	total: number;
	/**
	 * Every distinct message the replay saw, kept or not. `undefined` on a row stored
	 * before the engine deduplicated, whose list is one entry per occurrence.
	 */
	distinct: number | undefined;
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
	const trace = results?.find(isTestValidationRow)?.trace;
	const messages = trace?.failures;
	if (!trace || !messages || messages.length === 0) return null;
	return {
		messages,
		// A count missing from a short or absent list reads as one occurrence.
		counts: messages.map((_, i) => trace.failureCounts?.[i] ?? 1),
		total: trace.totalFailed ?? messages.length,
		distinct: trace.failuresDistinct,
		passed: trace.totalPassed ?? 0,
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
