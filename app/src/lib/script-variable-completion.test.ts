/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rule behind variable-name completion in the script editors.
 *
 * Two halves are worth pinning here rather than only through Monaco: which
 * scope an accessor implies (offering the wrong one hands you a name that
 * resolves to `undefined` at run time), and where a string literal starts
 * (which is also what keeps the `pm.*` list out of a name argument).
 */

import { describe, it, expect } from "vitest";
import { openStringLiteral, scriptVariableCompletionContext } from "./script-variable-completion";

describe("openStringLiteral", () => {
	it("finds the quote a caret sits inside, of each flavour", () => {
		expect(openStringLiteral('f("')).toEqual({ quote: '"', index: 2 });
		expect(openStringLiteral("f('")).toEqual({ quote: "'", index: 2 });
		expect(openStringLiteral("f(`")).toEqual({ quote: "`", index: 2 });
	});

	it("returns null once the string is closed again", () => {
		expect(openStringLiteral('f("done")')).toBeNull();
		expect(openStringLiteral("pm.response.code")).toBeNull();
	});

	it("does not let an escaped quote close the string", () => {
		expect(openStringLiteral('f("a\\"b')).toEqual({ quote: '"', index: 2 });
	});

	it("reopens on a second literal after the first one closed", () => {
		expect(openStringLiteral('f("a"); g("b')).toEqual({ quote: '"', index: 10 });
	});

	it("treats a different quote inside a string as content, not a delimiter", () => {
		expect(openStringLiteral("f(\"it's")).toEqual({ quote: '"', index: 2 });
	});
});

describe("scriptVariableCompletionContext", () => {
	it("takes the scope from the accessor, since that is what the call reads", () => {
		const cases: Array<[string, string]> = [
			['pm.environment.get("', "environment"],
			["pm.globals.get('", "global"],
			['pm.collectionVariables.get("', "collection"],
			['pm.variables.get("', "all"],
		];
		for (const [line, scope] of cases) {
			expect(scriptVariableCompletionContext(line)?.scope).toBe(scope);
		}
	});

	it("reports what has been typed, and where replacing it starts", () => {
		const context = scriptVariableCompletionContext('pm.environment.get("ba');
		expect(context).toMatchObject({ scope: "environment", mode: "name", query: "ba" });
		// The opening quote is at index 19, so the name starts at 20.
		expect(context?.startIndex).toBe(20);
	});

	it("covers the writing accessors too, not just get", () => {
		for (const method of ["get", "set", "has", "unset"]) {
			expect(scriptVariableCompletionContext(`pm.environment.${method}("`)).not.toBeNull();
		}
	});

	it("offers nothing for the second argument, which is a value and not a name", () => {
		expect(scriptVariableCompletionContext('pm.environment.set("token", "')).toBeNull();
	});

	it("skips pm.variables.set and unset, which the merged view does not support", () => {
		expect(scriptVariableCompletionContext('pm.variables.set("')).toBeNull();
		expect(scriptVariableCompletionContext('pm.variables.unset("')).toBeNull();
	});

	it("switches to brace syntax for replaceIn, which interpolates its argument", () => {
		const context = scriptVariableCompletionContext('pm.variables.replaceIn("{{ba');
		expect(context).toMatchObject({ scope: "all", mode: "template", query: "ba" });
	});

	it("offers nothing in replaceIn until the braces are open", () => {
		expect(scriptVariableCompletionContext('pm.variables.replaceIn("')).toBeNull();
	});

	it("ignores calls that are not variable accessors", () => {
		expect(scriptVariableCompletionContext('console.log("')).toBeNull();
		expect(scriptVariableCompletionContext('pm.response.headers.get("')).toBeNull();
		expect(scriptVariableCompletionContext('pm.test("')).toBeNull();
	});

	it("needs the caret inside the argument, not merely after the paren", () => {
		expect(scriptVariableCompletionContext("pm.environment.get(")).toBeNull();
		expect(scriptVariableCompletionContext('pm.environment.get("done")')).toBeNull();
	});

	it("tolerates the whitespace a formatter can leave in the call", () => {
		expect(scriptVariableCompletionContext('pm . environment . get ( "')?.scope).toBe(
			"environment"
		);
	});

	it("reads the accessor nearest the caret when a line holds two calls", () => {
		expect(
			scriptVariableCompletionContext('pm.environment.get("a"); pm.globals.get("')?.scope
		).toBe("global");
	});
});
