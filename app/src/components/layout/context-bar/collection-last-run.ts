/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Last run section says about a collection run, as plain functions
 * over the list row - so "which parts are actually present" is answerable in a
 * unit test rather than by opening the bar. The same split `run-scenario.ts`
 * makes for the run tab's sections.
 */

import type { Run } from "@/types";

/**
 * The status word and the token that colours it.
 *
 * The `--status-*-text` family, which is the one meant for the colour *being*
 * the text (see app/CLAUDE.md) - `--status-*` is the dot/tint and would fail
 * contrast at this size. `pending` and `running` deliberately share the running
 * token: from here they are the same answer, "no outcome yet".
 */
export const RUN_STATUS_TONE: Record<Run["status"], { label: string; className: string }> = {
	completed: { label: "Completed", className: "text-status-success-text" },
	failed: { label: "Failed", className: "text-status-error-text" },
	stopped: { label: "Stopped", className: "text-status-stopped-text" },
	running: { label: "Running", className: "text-status-running-text" },
	pending: { label: "Queued", className: "text-status-running-text" },
};

/**
 * "3 steps", and "× 2" only when more than one pass ran - one pass is the
 * default, and printing it on every row is noise rather than information.
 *
 * Null for a run stored before the engine sent the descriptor: the plan's
 * length was not recorded, which is not the same as a run of nothing, and
 * "0 steps" would be a claim about the plan.
 */
export function scenarioSizeLabel(run: Run): string | null {
	const scenario = run.summary?.scenario;
	if (scenario?.stepCount == null) return null;
	const steps = `${scenario.stepCount} step${scenario.stepCount === 1 ? "" : "s"}`;
	return scenario.iterations != null && scenario.iterations > 1
		? `${steps} × ${scenario.iterations}`
		: steps;
}
