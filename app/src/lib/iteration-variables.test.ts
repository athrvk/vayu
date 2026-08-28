/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import {
	ITERATION_VARIABLES,
	isIterationVariableName,
	iterationVariable,
} from "./iteration-variables";

describe("ITERATION_VARIABLES", () => {
	test("names exactly $vu and $iteration, with a non-empty description each", () => {
		expect(ITERATION_VARIABLES.map((v) => v.name)).toEqual(["$vu", "$iteration"]);
		for (const variable of ITERATION_VARIABLES) {
			expect(variable.description.trim()).not.toBe("");
		}
	});

	test("carries no generate function - the value is bound by the run, not at compose time", () => {
		for (const variable of ITERATION_VARIABLES) {
			expect((variable as { generate?: unknown }).generate).toBeUndefined();
		}
	});
});

describe("isIterationVariableName", () => {
	test("true for exactly the two reserved names", () => {
		expect(isIterationVariableName("$vu")).toBe(true);
		expect(isIterationVariableName("$iteration")).toBe(true);
	});

	test("false for a name that only looks like the identity, an ordinary name, or a dynamic generator", () => {
		expect(isIterationVariableName("$vus")).toBe(false);
		expect(isIterationVariableName("$iterations")).toBe(false);
		expect(isIterationVariableName("vu")).toBe(false);
		expect(isIterationVariableName("$guid")).toBe(false);
		expect(isIterationVariableName("")).toBe(false);
	});
});

describe("iterationVariable", () => {
	test("answers with the entry a surface can describe the token from", () => {
		expect(iterationVariable("$vu")).toBe(ITERATION_VARIABLES[0]);
		expect(iterationVariable("$iteration")).toBe(ITERATION_VARIABLES[1]);
	});

	test("agrees with isIterationVariableName on every name either is asked", () => {
		// The two must never disagree: a surface that decides a name is reserved
		// and then finds nothing to say about it has no token to paint.
		for (const name of ["$vu", "$iteration", "$vus", "vu", "$guid", ""]) {
			expect(iterationVariable(name) !== undefined).toBe(isIterationVariableName(name));
		}
	});
});
