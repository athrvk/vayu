/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Run } from "@/types";

/**
 * Runs that have a final report to diff: a run still executing has only the
 * requests so far, and a failed one may never have produced a result. The
 * pinned baseline joins the list when it is older than the page, since a pin
 * outliving the loaded rows is the main use of one.
 */
export function comparableRuns(
	runs: Run[],
	baselineRun: Run | null | undefined,
	openRunId: string
): Run[] {
	const byId = new Map<string, Run>();
	for (const run of [...runs, ...(baselineRun ? [baselineRun] : [])]) {
		if (run.type === "load") byId.set(run.id, run);
	}
	return [...byId.values()]
		.filter(
			(run) =>
				run.id !== openRunId && (run.status === "completed" || run.status === "stopped")
		)
		.sort((a, b) => b.startTime - a.startTime);
}
