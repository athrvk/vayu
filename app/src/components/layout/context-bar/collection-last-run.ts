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

import { RUN_STATUS } from "@/components/shared/run-status";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { Run } from "@/types";

/** From here `pending` is "Queued" in the running token: both say "no outcome yet". */
const QUEUED_TONE = { label: "Queued", className: RUN_STATUS.running.text };

/**
 * The status word and the token that colours it, read from `RUN_STATUS` so this
 * section cannot disagree with the other status surfaces. `RUN_STATUS.text` is
 * the `--status-*-text` token, the one meant for the colour *being* the text
 * (see app/CLAUDE.md); `pending` is the only status this section words itself.
 */
export function runStatusTone(status: Run["status"]): { label: string; className: string } {
	if (status === "pending") return QUEUED_TONE;
	const { label, text } = RUN_STATUS[status];
	return { label, className: text };
}

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
	const steps = `${scenario.stepCount} ${pluralize(scenario.stepCount, "step")}`;
	return scenario.iterations != null && scenario.iterations > 1
		? `${steps} × ${scenario.iterations}`
		: steps;
}
