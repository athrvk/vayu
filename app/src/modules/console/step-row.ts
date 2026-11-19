/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection run's `step` frame as its session Console row (#3634), apart
 * from `console-rows.ts` because `scenario-run-service.ts` imports it: that
 * file reaches the response viewer, and the service sits under `@/services`,
 * which `@/queries` imports.
 */

import type { ScenarioStepEvent } from "@/types";
import type { ConsoleStepRow } from "@/stores/console-store";

/** The frame's URL is the engine's, already masked and cut, so it is kept as written. */
export function stepConsoleRow(runId: string, step: ScenarioStepEvent): ConsoleStepRow {
	return {
		kind: "step",
		runId,
		iteration: step.iteration,
		stepIndex: step.stepIndex,
		name: step.name,
		outcome: step.outcome,
		...(step.method && { method: step.method }),
		...(step.url !== undefined && { url: step.url }),
		status: step.statusCode,
		timeMs: step.latencyMs,
		...(step.bodyBytes !== undefined && { sizeBytes: step.bodyBytes }),
		...(step.requestId && { requestId: step.requestId }),
	};
}
