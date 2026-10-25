/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which of a report's figures the engine did not record (#2895).
 *
 * `summary.summaryMissing` (a failed run with no summary) means the counts are
 * not whole-run totals: at most a sample's, often 0. The latency is the
 * engine's own statement: the report omits `latency` for a run whose latency
 * was never recorded (`summary.partial`, `summary.summaryMissing`; #2938), so
 * the block's absence is what is read here. Read once so each tile asks the
 * same question the same way, and a 0 never stands in for "not recorded".
 */

import type { RunReport } from "@/types";

/** What a tile draws where its figure was not recorded. */
export const NOT_RECORDED = "not recorded";

export interface UnrecordedFigures {
	/** The request counts, error rate and everything derived from them. */
	counts: boolean;
	/** Every latency figure: the report carries no `latency` block. */
	latency: boolean;
}

export function unrecordedFiguresOf(
	report: Pick<RunReport, "summary" | "latency">
): UnrecordedFigures {
	return {
		counts: report.summary?.summaryMissing === true,
		latency: report.latency === undefined,
	};
}
