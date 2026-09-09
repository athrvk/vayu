/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";

import { hasIncompleteElement, isBlankScriptElement, missingRequiredKeys } from "./elements";
import type { ElementKindSchema } from "@/types";

/** A minimal catalogue entry - only what `missingRequiredKeys` reads. */
function kindFixture(kind: string, required: string[]): ElementKindSchema {
	return {
		kind,
		version: 1,
		label: kind,
		description: "",
		category: "test",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object", required },
		phases: [],
	};
}

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

describe("missingRequiredKeys", () => {
	const kinds = [
		kindFixture("extract.json", ["variable", "path"]),
		kindFixture("timer.pacing", []),
	];

	it("lists every required key a fresh config: {} is missing", () => {
		expect(missingRequiredKeys({ kind: "extract.json", config: {} }, kinds)).toEqual([
			"variable",
			"path",
		]);
	});

	it("drops a key once it holds any value, including an empty string", () => {
		expect(
			missingRequiredKeys({ kind: "extract.json", config: { variable: "" } }, kinds)
		).toEqual(["path"]);
	});

	it("is empty once every required key is present", () => {
		expect(
			missingRequiredKeys(
				{ kind: "extract.json", config: { variable: "x", path: "$.y" } },
				kinds
			)
		).toEqual([]);
	});

	it("is empty for a kind with no required keys", () => {
		expect(missingRequiredKeys({ kind: "timer.pacing", config: {} }, kinds)).toEqual([]);
	});

	it("is empty for a kind the catalogue no longer registers", () => {
		expect(missingRequiredKeys({ kind: "extract.gone", config: {} }, kinds)).toEqual([]);
	});
});

describe("hasIncompleteElement", () => {
	const kinds = [kindFixture("extract.json", ["variable"]), kindFixture("timer.pacing", [])];

	it("is true when any element in the list is missing a required key", () => {
		const elements = [
			{ id: "1", kind: "timer.pacing", enabled: true, config: {} },
			{ id: "2", kind: "extract.json", enabled: true, config: {} },
		];
		expect(hasIncompleteElement(elements, kinds)).toBe(true);
	});

	it("is false once every element carries its required keys", () => {
		const elements = [
			{ id: "1", kind: "timer.pacing", enabled: true, config: {} },
			{ id: "2", kind: "extract.json", enabled: true, config: { variable: "token" } },
		];
		expect(hasIncompleteElement(elements, kinds)).toBe(false);
	});

	it("is false for an empty list", () => {
		expect(hasIncompleteElement([], kinds)).toBe(false);
	});
});
