/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The javascript span-finder for `useEditorVariableTokens` (issue #1220 script
 * support): what a script's `pm.<accessor>.get(...)`, `pm.variables.replaceIn(...)`
 * and bare `{{name}}` spans are, in Monaco's line/column space.
 *
 * Pure and Monaco-free, like `monaco-variable-tokens.test.ts` beside it - a
 * `ScannableModel` stub is two functions, not a real editor.
 */

import { describe, it, expect } from "vitest";
import { scriptVariableTokenRanges } from "./script-variable-tokens";
import type { ScannableModel } from "./monaco-variable-tokens";

function model(lines: string[]): ScannableModel {
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
	};
}

describe("scriptVariableTokenRanges", () => {
	it("finds each accessor's string-literal argument, scoped to what it reads", () => {
		const ranges = scriptVariableTokenRanges(
			model([
				'const a = pm.environment.get("baseUrl");',
				'const b = pm.globals.get("token");',
				'const c = pm.collectionVariables.get("shopId");',
				'const d = pm.variables.get("merged");',
				'const e = pm.iterationData.get("email");',
			])
		);

		const byName = new Map(ranges.map((r) => [r.name, r]));
		expect(byName.get("baseUrl")?.scriptHint).toEqual({ via: "scope", scope: "environment" });
		expect(byName.get("token")?.scriptHint).toEqual({ via: "scope", scope: "global" });
		expect(byName.get("shopId")?.scriptHint).toEqual({ via: "scope", scope: "collection" });
		// The merged read carries no hint - it falls through to the ordinary ladder.
		expect(byName.get("merged")?.scriptHint).toBeUndefined();
		expect(byName.get("email")?.scriptHint).toEqual({ via: "row" });
	});

	it("reports the argument's own position, not the call's", () => {
		const ranges = scriptVariableTokenRanges(model(['pm.environment.get("baseUrl");']));
		const range = ranges.find((r) => r.name === "baseUrl");
		expect(range).toMatchObject({ lineNumber: 1, startColumn: 21, endColumn: 28 });
	});

	it("also matches the optional-chained spelling", () => {
		const ranges = scriptVariableTokenRanges(model(['pm?.environment?.get("baseUrl");']));
		expect(ranges.map((r) => r.name)).toContain("baseUrl");
	});

	it("ignores a setter - only .get is a read", () => {
		const ranges = scriptVariableTokenRanges(model(['pm.environment.set("baseUrl", "x");']));
		expect(ranges.some((r) => r.name === "baseUrl")).toBe(false);
	});

	it("finds every {{name}} inside a replaceIn(...) template, with no scope hint", () => {
		const ranges = scriptVariableTokenRanges(
			model(['const u = pm.variables.replaceIn("{{host}}/{{path}}");'])
		);
		const names = ranges.filter((r) => r.scriptHint === undefined).map((r) => r.name);
		expect(names).toEqual(["host", "path"]);
	});

	it("matches a bare {{name}} outside replaceIn as muted and informational", () => {
		const ranges = scriptVariableTokenRanges(model(['const u = "{{host}}";']));
		expect(ranges).toHaveLength(1);
		expect(ranges[0]).toMatchObject({ name: "host", scriptHint: { via: "bare" } });
	});

	it("does not double-count a replaceIn template's own tokens as bare", () => {
		const ranges = scriptVariableTokenRanges(model(['pm.variables.replaceIn("{{host}}");']));
		expect(ranges).toHaveLength(1);
		expect(ranges[0].scriptHint).toBeUndefined();
	});

	it("ignores a name inside a // line comment", () => {
		const ranges = scriptVariableTokenRanges(
			model(['// pm.environment.get("baseUrl");', "const x = 1;"])
		);
		expect(ranges).toHaveLength(0);
	});

	it("ignores a name inside a /* */ block comment, including one spanning lines", () => {
		const ranges = scriptVariableTokenRanges(
			model(["/*", 'pm.environment.get("baseUrl");', "{{bare}}", "*/", "const x = 1;"])
		);
		expect(ranges).toHaveLength(0);
	});

	it("does not treat // inside a string as a comment", () => {
		const ranges = scriptVariableTokenRanges(
			model(['pm.environment.get("https://example.com");'])
		);
		expect(ranges.map((r) => r.name)).toEqual(["https://example.com"]);
	});

	it("finds every accessor read and the bare template together, each scoped correctly", () => {
		const ranges = scriptVariableTokenRanges(
			model([
				'const base = pm.environment.get("baseUrl");',
				'// pm.globals.get("ignored") in a comment',
				'const full = pm.variables.replaceIn("{{base}}/x");',
				'const literal = "{{unwrapped}}";',
			])
		);
		const byName = new Map(ranges.map((r) => [r.name, r.scriptHint]));
		expect(byName.get("baseUrl")).toEqual({ via: "scope", scope: "environment" });
		expect(byName.get("ignored")).toBeUndefined(); // never found - it was in a comment
		expect(ranges.some((r) => r.name === "ignored")).toBe(false);
		expect(byName.get("base")).toBeUndefined(); // the replaceIn template - merged ladder
		expect(byName.get("unwrapped")).toEqual({ via: "bare" });
	});
});
