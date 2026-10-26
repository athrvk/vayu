/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sequence block rides gate frames alone (issue #2823), so the live view
 * reads the latest frame that carries it rather than the newest tick.
 *
 * Mutation-check: read only the last frame and the non-gate-last case fails;
 * scan from the front and the newest-wins case fails.
 */

import { describe, it, expect } from "vitest";
import type { LiveScenarioProgress } from "@/types";
import { latestScenarioProgress } from "./liveScenario";
import { tick } from "./liveDistributions.testkit";

const progress = (iterationsCompleted: number): LiveScenarioProgress => ({
	iterations: iterationsCompleted + 1,
	iterationsCompleted,
	iterationsAbandoned: 0,
	stepsExecuted: iterationsCompleted * 2,
	steps: [{ index: 0, name: "Log in", executed: iterationsCompleted, errors: 0 }],
});

describe("latestScenarioProgress", () => {
	it("returns the block of the newest frame that carries one, past plain ticks", () => {
		const older = progress(3);
		const newer = progress(7);
		const history = [tick(1, { scenario: older }), tick(2, { scenario: newer }), tick(2.1)];

		expect(latestScenarioProgress(history)).toBe(newer);
	});

	it("is undefined for a run whose frames carry none", () => {
		expect(latestScenarioProgress([tick(1), tick(2)])).toBeUndefined();
		expect(latestScenarioProgress([])).toBeUndefined();
	});
});
