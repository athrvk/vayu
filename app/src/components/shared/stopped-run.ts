/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the budgets card says about a stopped run (#2194): the engine judges it on what it measured
 * before the stop, and "Passed" over three seconds of a twenty-second plan is a weaker claim than
 * over the plan. Both hosts of {@link ThresholdVerdict} hold the full report, so the reading is
 * done here.
 */

import { durationSeconds } from "@/constants/load-test";
import type { RunReport } from "@/types/domain";

export interface StoppedRun {
	/** Absent when the report carries no usable measure of how long the run went. */
	elapsedSeconds?: number;
	/** Absent for a run with no declared duration (iterations, ramp, scenarios). */
	plannedSeconds?: number;
}

function positive(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Seconds the run ran: the engine's `totalDurationSeconds`, the stored wall clock, wins; the
 * start/end stamps stand in for a summary without one.
 */
function elapsedSecondsOf(report: Pick<RunReport, "metadata" | "summary">): number | undefined {
	const reported = positive(report.summary?.totalDurationSeconds);
	if (reported !== undefined) return reported;
	const start = report.metadata?.startTime;
	const end = report.metadata?.endTime;
	if (!start || !end) return undefined;
	return positive((end - start) / 1000);
}

/** `undefined` for any run that was not stopped, which is what keeps the note off those. */
export function stoppedRunOf(
	report: Pick<RunReport, "metadata" | "summary">
): StoppedRun | undefined {
	if (report.metadata?.status !== "stopped") return undefined;
	return {
		elapsedSeconds: elapsedSecondsOf(report),
		plannedSeconds: durationSeconds(report.metadata.configuration?.duration) ?? undefined,
	};
}
