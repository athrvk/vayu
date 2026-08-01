/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { calleeOnlyInsertText } from "./script-completion-insert";

describe("calleeOnlyInsertText", () => {
	it("drops the snippet's own call when the line already opens one", () => {
		// `pm.variables.rep|("$guid")` - accepting the snippet whole produced
		// `pm.variables.replaceIn("template")("$guid")`, which is the report.
		expect(calleeOnlyInsertText('pm.variables.replaceIn(${1:"template"})', '("$guid")')).toBe(
			"pm.variables.replaceIn"
		);
	});

	it("keeps the whole snippet when nothing follows the cursor", () => {
		expect(calleeOnlyInsertText('pm.variables.replaceIn(${1:"template"})', "")).toBeNull();
	});

	it("keeps the whole snippet when what follows is not a call", () => {
		// `pm.te| // note` has no parens to collide with.
		expect(calleeOnlyInsertText("pm.expect(${1:value})", " // note")).toBeNull();
		expect(calleeOnlyInsertText("pm.expect(${1:value})", ")")).toBeNull();
	});

	it("only looks at the character immediately after the cursor", () => {
		// A `(` further along the line belongs to something else.
		expect(calleeOnlyInsertText("pm.expect(${1:value})", ".to.equal(1)")).toBeNull();
		expect(calleeOnlyInsertText("pm.expect(${1:value})", " (x)")).toBeNull();
	});

	it("leaves a value completion alone - it carries no call to duplicate", () => {
		expect(calleeOnlyInsertText("pm.response.code", "()")).toBeNull();
	});

	it("handles a multi-line snippet, taking only the callee path", () => {
		expect(
			calleeOnlyInsertText('pm.test("${1:name}", function() {\n\t${2:// body}\n});', "();")
		).toBe("pm.test");
	});

	it("refuses to produce a callee that is not a plain dotted path", () => {
		// Defensive: a snippet whose head holds a placeholder would otherwise
		// insert `${1:x}` as literal text once the snippet rule is dropped.
		expect(calleeOnlyInsertText("${1:obj}.get(${2:key})", "()")).toBeNull();
	});
});
