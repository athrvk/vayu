/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sequence a scenario load run has run so far, for the live view's panel
 * (issue #2823).
 *
 * The engine sends the block on gate frames alone, about one frame a second, so
 * the newest tick usually lacks it: a reader of `currentMetrics` would flicker
 * between the panel and nothing. This takes the latest frame that carries it
 * (the rule `latestGateFrame` follows), and returns the block itself, so the
 * panel's prop keeps its identity across the frames between two gates.
 */

import type { LiveScenarioProgress, LoadTestMetrics } from "@/types";

/** The latest sequence block in the buffer, or `undefined` for a run with none. */
export function latestScenarioProgress(
	history: readonly LoadTestMetrics[]
): LiveScenarioProgress | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const scenario = history[i].scenario;
		if (scenario !== undefined) return scenario;
	}
	return undefined;
}
