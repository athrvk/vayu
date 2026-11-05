/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bound-column deferral (issue #1007), beyond the four cases the shared
 * conformance fixture pins.
 *
 * The fixture is the contract with the engine and covers the flat reads; what
 * is left to assert here is the part that is this module's own - that the
 * deferral survives the nesting the engine expresses differently, and that the
 * empty default really is "resolve exactly as before" rather than a set the
 * caller has to remember to pass.
 */

import { describe, it, expect } from "vitest";
import { buildVariableValues, coerceVariableValue, resolveTemplate } from "./variable-resolution";

const ENVIRONMENT = buildVariableValues({
	environment: {
		username: { value: "ada", enabled: true },
		greeting: { value: "hello {{username}}", enabled: true },
	},
});

const lookup = (name: string) => ENVIRONMENT.get(name);

describe("a bound data row's bare column names", () => {
	it("keeps its braces where an environment variable shares the name", () => {
		expect(resolveTemplate("/u/{{username}}", lookup, new Set(["username"]))).toBe(
			"/u/{{username}}"
		);
	});

	it("resolves from the environment when no row is bound", () => {
		expect(resolveTemplate("/u/{{username}}", lookup)).toBe("/u/ada");
	});

	it("stays deferred inside a value that carries tokens of its own", () => {
		// The nesting case `data.*` already answers: a bound column reached
		// through another variable's value is still the row's to substitute, so
		// the inner token has to survive the expansion rather than being resolved
		// one level down where the set is out of sight.
		expect(resolveTemplate("{{greeting}}", lookup, new Set(["username"]))).toBe(
			"hello {{username}}"
		);
	});
});

describe("coerceVariableValue (#3245)", () => {
	it("reads a stored value as the text a send uses", () => {
		expect(coerceVariableValue("x")).toBe("x");
		expect(coerceVariableValue(5)).toBe("5");
		expect(coerceVariableValue(true)).toBe("true");
		expect(coerceVariableValue({ a: 1 })).toBe('{"a":1}');
		expect(coerceVariableValue([1, "x"])).toBe('[1,"x"]');
		expect(coerceVariableValue(null)).toBe("");
		expect(coerceVariableValue(undefined)).toBe("");
	});
});
