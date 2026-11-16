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

import { OUTCOME_TITLE, rowOutcome } from "@/components/shared/run-outcome";
import { RUN_STATUS, runStatusDisplay } from "@/components/shared/run-status";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { Run } from "@/types";

/** From here `pending` is "Queued" in the running token: both say "no outcome yet". */
const QUEUED_TONE: RunStatusTone = {
	label: "Queued",
	className: RUN_STATUS.running.text,
	verdict: null,
};

export interface RunStatusTone {
	label: string;
	className: string;
	/** The verdict's word when the run has one, for the row's accessible name. */
	verdict: string | null;
}

/**
 * The status word and the token that colours it, read through `runStatusDisplay`
 * so this section cannot disagree with the other status surfaces. The `text` it
 * answers is the `--status-*-text` token, the one meant for the colour *being*
 * the text (see app/CLAUDE.md). A completed collection run with a failed or
 * errored step reads in the error colour, as its History row does (#3496);
 * `pending` is the only status this section words itself.
 */
export function runStatusTone(run: Run): RunStatusTone {
	if (run.status === "pending") return QUEUED_TONE;
	const judgement = rowOutcome(run);
	const { label, text } = runStatusDisplay(run.status, judgement?.outcome);
	return {
		label,
		className: text,
		verdict: judgement ? OUTCOME_TITLE[judgement.outcome].toLowerCase() : null,
	};
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
