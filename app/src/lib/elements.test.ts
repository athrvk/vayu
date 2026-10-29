/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";

import {
	hasIncompleteElement,
	isBlankScriptElement,
	missingOperand,
	missingRequiredKeys,
	parseElementRefusal,
} from "./elements";
import type { ElementDef, ElementKindSchema } from "@/types";

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

describe("missingOperand", () => {
	it.each([
		["assert.status", {}],
		["assert.status", { in: [] }],
		["assert.jsonpath", { path: "$.id" }],
		["control.throughput", {}],
		["control.throughput", { perUser: false }],
		["timer.think", {}],
		["timer.think", { minMs: 100 }],
		["timer.think", { maxMs: 100 }],
		// A cleared field leaves `text: ""`; `contains` is the default mode.
		["assert.contains", { text: "" }],
		["assert.contains", { text: "", mode: "contains" }],
	])("names what a %s with %j still needs", (kind, config) => {
		expect(missingOperand({ kind, config })).toEqual(expect.any(String));
	});

	it.each([
		["assert.status", { in: [200] }],
		["assert.status", { range: { min: 200, max: 299 } }],
		["assert.status", { in: [], range: { min: 200, max: 299 } }],
		["assert.jsonpath", { path: "$.id", expected: 1 }],
		// The engine tests presence, so an empty string and a null both count.
		["assert.jsonpath", { path: "$.id", expected: "" }],
		["assert.jsonpath", { path: "$.id", expected: null }],
		["assert.jsonpath", { path: "$.id", regex: "^a" }],
		["assert.jsonpath", { path: "$.id", exists: false }],
		["control.throughput", { percent: 50 }],
		["control.throughput", { everyN: 2, perUser: false }],
		["timer.think", { ms: 0 }],
		["timer.think", { minMs: 100, maxMs: 300 }],
		["timer.think", { gaussian: { meanMs: 200, deviationMs: 20 } }],
		["assert.contains", { text: "ok" }],
		// `equals` and `matches` read an empty text as a value; an absent one is
		// `missingRequiredKeys`' to report, not this rule's.
		["assert.contains", { text: "", mode: "equals" }],
		["assert.contains", { text: "", mode: "matches" }],
		["assert.contains", {}],
	])("is satisfied by a %s with %j", (kind, config) => {
		expect(missingOperand({ kind, config })).toBeNull();
	});

	it("has no opinion on a kind without an operand rule", () => {
		expect(missingOperand({ kind: "assert.duration", config: {} })).toBeNull();
	});
});

describe("hasIncompleteElement", () => {
	const kinds = [kindFixture("extract.json", ["variable"]), kindFixture("timer.pacing", [])];

	it("is true for a status assertion with no accepted codes or range, though the catalogue requires nothing of it", () => {
		const elements = [{ id: "1", kind: "assert.status", enabled: true, config: {} }];
		expect(hasIncompleteElement(elements, [kindFixture("assert.status", [])])).toBe(true);
	});

	it("is false once that assertion lists a code", () => {
		const elements = [{ id: "1", kind: "assert.status", enabled: true, config: { in: [200] } }];
		expect(hasIncompleteElement(elements, [kindFixture("assert.status", [])])).toBe(false);
	});

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

describe("parseElementRefusal", () => {
	const sent: ElementDef[] = [
		{ id: "a", kind: "assert.status", enabled: true, config: { in: [200] } },
		{ id: "b", kind: "extract.regex", enabled: true, config: { pattern: "(" } },
	];

	it("finds the element by the 1-based item index and drops the label prefix", () => {
		const found = parseElementRefusal(
			"'Extract with a regular expression' (item 2): 'pattern' is not a valid regular expression",
			sent
		);
		expect(found?.element).toBe(sent[1]);
		expect(found?.problem).toBe("'pattern' is not a valid regular expression");
	});

	it("keeps a multi-line problem whole", () => {
		const found = parseElementRefusal("'Assert text' (item 1): first\nsecond", sent);
		expect(found?.problem).toBe("first\nsecond");
	});

	it.each([
		["a message about no element", "Request name is required"],
		["an engine that names the item without a kind label", "Item 2 is missing an id"],
		["an index past the array", "'Assert text' (item 3): nope"],
		["item zero", "'Assert text' (item 0): nope"],
	])("answers null for %s", (_name, message) => {
		expect(parseElementRefusal(message, sent)).toBeNull();
	});
});
