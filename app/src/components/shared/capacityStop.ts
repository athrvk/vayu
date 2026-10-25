/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Why a capacity search stopped, in words. The Capacity summary and the
 * dashboard's Saturation card both read this one table (#2816), so the two
 * cannot word the same stop differently.
 */

import type { RunReport } from "@/types/domain";

export type CapacityResult = NonNullable<RunReport["capacity"]>;

/**
 * What a stop says about the target. `degrading`: the search watched latency or
 * errors give out. `saturated`: throughput stopped growing. `none`: the search
 * ended on a bound the caller set (ceiling, deadline, a hand stop), which is a
 * floor and not a limit.
 */
export type StopFinding = "degrading" | "saturated" | "none";

export interface StopReason {
	label: string;
	detail: string;
	finding: StopFinding;
}

/**
 * Unknown reasons are absent from the table and render under their raw key
 * rather than vanishing: a newer sidecar may stop for a reason this build has no
 * words for, and the levels still say what happened.
 */
export const STOP_REASONS: Record<string, StopReason> = {
	slo_exceeded: {
		label: "Latency budget exceeded",
		detail: "p99 stayed above the budget across two consecutive windows.",
		finding: "degrading",
	},
	errors_exceeded: {
		label: "Errors exceeded the limit",
		detail: "More requests failed than the limit allows across two consecutive windows.",
		finding: "degrading",
	},
	plateau: {
		label: "Throughput plateaued",
		detail: "More virtual users stopped buying more throughput.",
		finding: "saturated",
	},
	cap_reached: {
		label: "Reached the virtual user ceiling",
		detail: "The target held its budget all the way up. Raise the ceiling to find the limit.",
		finding: "none",
	},
	deadline: {
		label: "Ran out of time",
		detail: "The run's deadline passed before the search found a limit.",
		finding: "none",
	},
	stopped: {
		label: "Stopped by hand",
		detail: "The run was stopped before the search reached a conclusion.",
		finding: "none",
	},
};
