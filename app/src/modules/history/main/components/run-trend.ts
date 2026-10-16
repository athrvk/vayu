/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunTrendPoint } from "@/modules/dashboard/components/charts/uplot";
import type { Run } from "@/types";

/** The most recent runs plotted: past this the chart is a smear and the oldest runs are history. */
export const RUN_TREND_LIMIT = 20;

/**
 * The runs a trend is drawn from: load runs that finished and recorded a
 * summary. A stopped run stays, flagged `stopped` - it is the run the user
 * judged enough, and dropping it would hide the latest state of a request they
 * stop routinely - and so does a failed one. A run still executing has no
 * summary yet, so the summary is the filter.
 *
 * Reads only the list row's `resultSummary` (#2130): no report is fetched.
 */
export function buildRunTrend(
	runs: readonly Run[],
	openRunId: string,
	limit: number = RUN_TREND_LIMIT
): RunTrendPoint[] {
	return runs
		.filter(
			(run): run is Run & { type: "load" } =>
				run.type === "load" &&
				run.resultSummary !== undefined &&
				(run.status === "completed" || run.status === "failed" || run.status === "stopped")
		)
		.sort((a, b) => b.startTime - a.startTime)
		.slice(0, limit)
		.reverse()
		.map((run) => ({
			startTime: run.startTime,
			stopped: run.status === "stopped",
			isOpen: run.id === openRunId,
			p95Ms: run.resultSummary?.p95Ms ?? null,
			rps: run.resultSummary?.rps ?? null,
			errorRate: run.resultSummary?.errorRate ?? null,
		}));
}
