/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";

import { isBlankScriptElement } from "./elements";

describe("isBlankScriptElement", () => {
	it("is true for an empty script.pre", () => {
		expect(isBlankScriptElement({ kind: "script.pre", config: { script: "" } })).toBe(true);
	});

	it("is true for a whitespace-only script.post", () => {
		expect(isBlankScriptElement({ kind: "script.post", config: { script: "  \n\t " } })).toBe(
			true
		);
	});

	it("is true when the script field is missing entirely", () => {
		expect(isBlankScriptElement({ kind: "script.pre", config: {} })).toBe(true);
	});

	it("is false once the script has non-whitespace text", () => {
		expect(isBlankScriptElement({ kind: "script.post", config: { script: "pm.test()" } })).toBe(
			false
		);
	});

	it("is false for a non-script kind, regardless of its config", () => {
		expect(isBlankScriptElement({ kind: "assert.status", config: { script: "" } })).toBe(false);
	});
});
