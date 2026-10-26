/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";

/** The `thresholdValidation` key the p99 budget is judged under. */
const P99_BUDGET_METRIC = "latencyP99Ms";

/**
 * The p99 line (ms) a stored run declared for itself, which is the only SLO its
 * charts and tiles may draw: a capacity run's own `sloMs`, else the limit of its
 * p99 budget, else `undefined`. The Settings SLO is a client preference, not a
 * property of the run, so it is never the answer (#2939).
 *
 * An unevaluated check (no completions, so no measurement) still names the
 * limit the run was held to. Capacity wins when a run has both: it is the line
 * the search stopped on.
 */
export function runSloMs(report: RunReport): number | undefined {
	if (report.capacity) return report.capacity.sloMs;
	return report.thresholdValidation?.checks.find((c) => c.metric === P99_BUDGET_METRIC)?.limit;
}
