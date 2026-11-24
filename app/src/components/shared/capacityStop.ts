/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Why a capacity search stopped, in words: the Capacity summary and the dashboard's Saturation card
 * read this one table (#2816), so the same stop is worded once. Label and finding are fixed per
 * reason; the detail depends on the report's figures, so it is `stopDetail`, not a field here.
 */

import { formatLatency, formatNumber } from "@/lib/format-number";
import type { RunReport } from "@/types/domain";

export type CapacityResult = NonNullable<RunReport["capacity"]>;

/**
 * What a stop says about the target: `degrading` (latency or errors gave out), `saturated`
 * (throughput stopped growing), `none` (a bound the caller set ended it: ceiling, deadline, a hand
 * stop), a floor and not a limit.
 */
export type StopFinding = "degrading" | "saturated" | "none";

export interface StopReason {
	label: string;
	finding: StopFinding;
}

/**
 * An unknown reason is absent here and renders under its raw key rather than vanishing: a newer
 * sidecar may stop for a reason this build cannot word, and the levels still say what happened.
 */
export const STOP_REASONS: Record<string, StopReason> = {
	slo_exceeded: { label: "Latency budget exceeded", finding: "degrading" },
	errors_exceeded: { label: "Errors exceeded the limit", finding: "degrading" },
	plateau: { label: "Throughput plateaued", finding: "saturated" },
	cap_reached: { label: "Reached the virtual user ceiling", finding: "none" },
	deadline: { label: "Ran out of time", finding: "none" },
	stopped: { label: "Stopped by hand", finding: "none" },
};

/** The detail of the stops whose wording does not depend on the report. */
const FIXED_DETAILS: Record<string, string> = {
	cap_reached: "The target held its budget all the way up. Raise the ceiling to find the limit.",
	deadline: "The run's deadline passed before the search found a limit.",
	stopped: "The run was stopped before the search reached a conclusion.",
};

/**
 * A breach is a verdict only once the level is measured twice; each measurement is one step, not a
 * time window, so the step length is the one duration the sentence can name.
 */
function consecutiveMeasurements(stepDuration: string | undefined): string {
	const each = stepDuration ? ` (each ${stepDuration} long)` : "";
	return `two consecutive measurements of the level${each}`;
}

function errorsDetail(capacity: CapacityResult, stepDuration: string | undefined): string {
	const span = consecutiveMeasurements(stepDuration);
	if (capacity.maxErrorPct === undefined) {
		return `More requests failed than the limit allows across ${span}.`;
	}
	return `More than ${formatNumber(capacity.maxErrorPct)}% of requests failed across ${span}.`;
}

/**
 * Quotes the p99 rise only when the report proves one (the saturation level's p99 against the last
 * level tried); a run predating `saturation*`, or whose p99 did not rise, gets the plain sentence
 * rather than a claim about latency the report cannot back.
 */
function plateauDetail(capacity: CapacityResult): string {
	const lead = "More virtual users stopped buying more throughput";
	const { saturationP99Ms, levels } = capacity;
	const last = levels[levels.length - 1];
	if (saturationP99Ms === undefined || last === undefined || last.p99Ms <= saturationP99Ms) {
		return `${lead}.`;
	}
	return `${lead}; p99 stayed inside the budget but rose from ${formatLatency(saturationP99Ms)} to ${formatLatency(last.p99Ms)}.`;
}

/**
 * The line under the Capacity headline: why the search stopped, in the report's figures.
 * `stepDuration` is `metadata.configuration.stepDuration` as sent ("5s"), absent for the default
 * step. Undefined for a reason this build cannot word.
 */
export function stopDetail(capacity: CapacityResult, stepDuration?: string): string | undefined {
	switch (capacity.stopReason) {
		case "slo_exceeded":
			return `p99 stayed above the budget across ${consecutiveMeasurements(stepDuration)}.`;
		case "errors_exceeded":
			return errorsDetail(capacity, stepDuration);
		case "plateau":
			return plateauDetail(capacity);
		default:
			return FIXED_DETAILS[capacity.stopReason];
	}
}
