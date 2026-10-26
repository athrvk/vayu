/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { liveRunProgressText } from "./scenario-run-header";

const PLAN = { stepsPerIteration: 6, iterations: 40, stepsExpected: 240 };

describe("liveRunProgressText", () => {
	it("is null before the plan frame, so the header keeps its bare Running", () => {
		expect(liveRunProgressText(null, { iteration: 3 }, 20)).toBeNull();
	});

	it("reads iteration 1 before any step has landed", () => {
		expect(liveRunProgressText(PLAN, undefined, 0)).toBe("Iteration 1 of 40 - 0 of 240 steps");
	});

	it("follows the iteration the latest step reports, not a division of the step count", () => {
		// An errored step ended iterations 0 and 1 after two steps each: 5 steps
		// run, which `floor(5 / 6) + 1` would call iteration 1.
		expect(liveRunProgressText(PLAN, { iteration: 2 }, 5)).toBe(
			"Iteration 3 of 40 - 5 of 240 steps"
		);
	});

	it("clamps the iteration to the plan", () => {
		expect(liveRunProgressText(PLAN, { iteration: 40 }, 240)).toBe(
			"Iteration 40 of 40 - 240 of 240 steps"
		);
	});

	it("drops the denominator for a run that outran its plan", () => {
		expect(liveRunProgressText(PLAN, { iteration: 39 }, 250)).toBe(
			"Iteration 40 of 40 - 250 steps"
		);
	});

	it("pluralises against the plan's own count", () => {
		expect(
			liveRunProgressText(
				{ stepsPerIteration: 1, iterations: 1, stepsExpected: 1 },
				undefined,
				0
			)
		).toBe("Iteration 1 of 1 - 0 of 1 step");
	});
});
