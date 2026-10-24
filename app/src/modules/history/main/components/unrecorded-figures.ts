/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which of a report's figures the engine did not record (#2895).
 *
 * Two flags on `summary` say it: `summaryMissing` (a failed run with no summary,
 * so the counts are not whole-run totals: at most a sample's, often 0) and
 * `partial` (a run reconciled after an engine crash: the counts are the last
 * saved tick's, the latency block is all zeros). Read here once so each tile
 * asks the same question the same way, and a 0 never stands in for "not
 * recorded".
 */

import type { RunReport } from "@/types";

/** What a tile draws where its figure was not recorded. */
export const NOT_RECORDED = "not recorded";

export interface UnrecordedFigures {
	/** The request counts, error rate and everything derived from them. */
	counts: boolean;
	/** Every latency figure. */
	latency: boolean;
}

export function unrecordedFiguresOf(summary: RunReport["summary"] | undefined): UnrecordedFigures {
	const missing = summary?.summaryMissing === true;
	return { counts: missing, latency: missing || summary?.partial === true };
}
