/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { ITERATION_VARIABLES, isIterationVariableName } from "./iteration-variables";

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
