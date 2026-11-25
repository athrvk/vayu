/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sentences a collection run's header says about the run as a whole: where
 * a live one is, and what a finished one did. Pure text over numbers the caller
 * already holds, so `ScenarioRunView` only decides which one to draw.
 */

import { formatNumber, formatSeconds } from "@/lib/format-number";
import { formatErrorPercent, pluralize } from "@/modules/dashboard/utils/format";
import type { RunReport, ScenarioRunPlanEvent } from "@/types";
import { NOT_RECORDED, unrecordedFiguresOf } from "./components/unrecorded-figures";
import type { ScenarioStepRow } from "./scenario-steps";

/**
 * "Iteration 3 of 40 - 17 of 240 steps" once the run's `plan` frame has arrived; `null` before it
 * (an older engine, or a client attached past the frame's eviction), when the header says only
 * "Running".
 *
 * The iteration is the latest step's own, not `stepsRun / stepsPerIteration`: an errored step ends
 * its iteration early and `setNextRequest` walks one in more or fewer steps than the plan, so the
 * division drifts. Before the first step the run is in iteration 1. Both counts are clamped to the
 * plan: `stepsExpected` is an upper bound on paper only (`ScenarioRunPlanEvent`), and "250 of 240"
 * contradicts itself, so a run past its plan drops the denominator.
 */
export function liveRunProgressText(
	plan: ScenarioRunPlanEvent | null,
	latestStep: Pick<ScenarioStepRow, "iteration"> | undefined,
	stepsRun: number
): string | null {
	if (!plan) return null;
	const iteration = Math.min(plan.iterations, (latestStep?.iteration ?? 0) + 1);
	const iterations = `Iteration ${formatNumber(iteration)} of ${formatNumber(plan.iterations)}`;
	if (stepsRun > plan.stepsExpected) {
		return `${iterations} - ${formatNumber(stepsRun)} ${pluralize(stepsRun, "step")}`;
	}
	return `${iterations} - ${formatNumber(stepsRun)} of ${formatNumber(plan.stepsExpected)} ${pluralize(plan.stepsExpected, "step")}`;
}

/**
 * "4.20s - 83 requests sent - 16.9% error rate" for an ended run, from the report's `summary`.
 * `totalRequests` is the steps that sent (#2822), so the error rate is over the same population and
 * left out when none did ("0.0%" over nothing is no rate). A summary the engine did not record
 * (#2895) says so once rather than printing zeros as measurements.
 */
export function finishedRunFiguresText(summary: RunReport["summary"]): string {
	if (unrecordedFiguresOf({ summary }).counts) {
		return `Duration, requests sent and error rate: ${NOT_RECORDED}`;
	}
	const parts = [
		formatSeconds(summary.totalDurationSeconds),
		`${formatNumber(summary.totalRequests)} ${pluralize(summary.totalRequests, "request")} sent`,
	];
	if (summary.totalRequests > 0) {
		parts.push(`${formatErrorPercent(summary.errorRate)}% error rate`);
	}
	return parts.join(" - ");
}
