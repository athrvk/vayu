/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a scenario load run's latency figures pool (#2823).
 *
 * The run's `latency` block, the live percentile card and the percentile charts
 * all fold every step's requests into one histogram, so a p99 over a sequence is
 * the tail of the whole mix, not any one request's. A reader who sees a bare
 * "P99 latency" cannot tell that the slowest step sets it; these helpers say so
 * wherever the pooled figure is shown. A single-request run pools nothing and
 * none of this applies to it.
 */

import { formatLatency } from "@/lib/format-number";
import type { RunReport, RunScenarioStepStat } from "@/types";

/** The step whose own p99 is the highest, with that figure. */
export interface SlowestStep {
	ms: number;
	name: string;
}

/** The pooled figures' qualifier on a derived bundle; `slowestStep` is absent live, where steps carry no latency. */
export interface PooledLatency {
	slowestStep?: SlowestStep;
}

/** The suffix a pooled chart or card title carries. */
const POOLED_TITLE_SUFFIX = " (all steps)";

/** `title` as the pooled figures' heading when `pooled`, unchanged otherwise. */
export function pooledTitle(title: string, pooled: boolean): string {
	return pooled ? `${title}${POOLED_TITLE_SUFFIX}` : title;
}

/**
 * Whether a report is a scenario load run: the predicate `LoadTestDetail` draws
 * its sequence banner and Steps tab by, so a figure's caption and the pane agree.
 */
export function isPooledReport(report: Pick<RunReport, "scenario">): boolean {
	return !!report.scenario?.steps?.length;
}

/** The step with the highest p99, or `undefined` for no steps. The first of equals wins. */
export function slowestStepP99(
	steps: readonly RunScenarioStepStat[] | undefined
): SlowestStep | undefined {
	let slowest: SlowestStep | undefined;
	for (const step of steps ?? []) {
		if (slowest && step.latency.p99 <= slowest.ms) continue;
		slowest = { ms: step.latency.p99, name: step.name || step.requestId };
	}
	return slowest;
}

/** "All steps pooled", plus the slowest step and its p99 where they are known. */
export function pooledCaption(slowestStep: SlowestStep | undefined): string {
	if (!slowestStep) return "All steps pooled";
	return `All steps pooled - slowest step: ${slowestStep.name}, p99 ${formatLatency(slowestStep.ms)}`;
}

/** The pooled-latency qualifier for a finished report; `undefined` for a single-request run. */
export function pooledLatencyOf(report: RunReport): PooledLatency | undefined {
	if (!isPooledReport(report)) return undefined;
	return { slowestStep: slowestStepP99(report.scenario?.steps) };
}
