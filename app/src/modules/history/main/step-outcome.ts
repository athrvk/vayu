/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How a collection-run step's outcome reads in a row. History's step card and the session Console's
 * step row (#3634) draw the same step, so they read one table.
 *
 * `skipped` has its own state and chip and is never dressed as a pass: a step the runner did not
 * execute asserted nothing. `failed` is a test assertion that did not hold while the response may
 * well be a `200`, which is why the state cannot be derived from the status code. `stopped` is a
 * step the run's Stop cut short (#3397): no failure, so it wears the run status's Stopped glyph,
 * not the error tick.
 */

import type { ExchangeState } from "@/components/shared/response-viewer";
import type { StepOutcome } from "@/types";

export const STEP_OUTCOME_STATE: Record<StepOutcome, ExchangeState> = {
	passed: "success",
	failed: "error",
	skipped: "skipped",
	errored: "error",
	stopped: "stopped",
};

/** Chip tint per outcome. `-fill` under a white label, per the token rules. */
export const STEP_OUTCOME_CHIP: Record<StepOutcome, string> = {
	passed: "bg-status-success-fill text-white",
	failed: "bg-status-error-fill text-white",
	skipped: "bg-muted text-muted-foreground",
	errored: "bg-status-error-fill text-white",
	stopped: "bg-status-stopped-fill text-white",
};

/**
 * Whether the step's status and time are a status and a time. A skipped step sent nothing (its 0
 * status and latency are storage values, #2824); a stopped step's send was cut short, so its 0 is
 * no status and its latency no response time (#3397).
 */
export function stepWasAnswered(outcome: StepOutcome): boolean {
	return outcome !== "skipped" && outcome !== "stopped";
}
