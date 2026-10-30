/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";

import {
	elementNeeds,
	errorsWithin,
	hasIncompleteElement,
	isBlankScriptElement,
	missingOperand,
	missingRequiredKeys,
	parseElementRefusal,
	isSupportedJsonPath,
	JSON_PATH_FIELDS,
	validateElementConfig,
} from "./elements";
import type { ElementConfigSchema, ElementDef, ElementKindSchema } from "@/types";

/** A minimal catalogue entry - only what `missingRequiredKeys` reads. */
function kindFixture(
	kind: string,
	required: string[],
	configSchema: ElementConfigSchema = { type: "object", required }
): ElementKindSchema {
	return {
		kind,
		version: 1,
		label: kind,
		description: "",
		category: "test",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema,
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

/**
 * The slice of each live schema (`engine/tests/fixtures/element-kinds.json`)
 * that carries a value constraint, transcribed so these cases do not need the
 * generated fixture. `element-kinds.conformance.test.tsx` is what holds the
 * validator to the real catalogue.
 */
const constrained = (
	kind: string,
	configSchema: Omit<ElementConfigSchema, "type">
): ElementKindSchema => kindFixture(kind, [], { type: "object", ...configSchema });

const CONSTRAINED_KINDS: ElementKindSchema[] = [
	constrained("assert.jsonpath", {
		required: ["path"],
		properties: { path: { type: "string" }, exists: { type: "boolean" } },
	}),
	constrained("extract.json", {
		required: ["path", "variable"],
		properties: { path: { type: "string" }, variable: { type: "string", minLength: 1 } },
	}),
	constrained("metric.record", {
		required: ["name", "type", "source"],
		properties: {
			name: { type: "string", minLength: 1, maxLength: 100 },
			source: {
				type: "object",
				properties: {
					jsonpath: { type: "string" },
					condition: {
						type: "object",
						required: ["field", "operator", "value"],
						properties: {
							field: { type: "string" },
							jsonpath: { type: "string" },
							value: null,
						},
					},
				},
			},
		},
	}),
	constrained("timer.pacing", {
		required: ["everyMs"],
		properties: { everyMs: { type: "integer", minimum: 1 } },
	}),
	constrained("timer.throughput", {
		required: ["targetPerMinute"],
		properties: { targetPerMinute: { type: "number", exclusiveMinimum: 0 } },
	}),
	constrained("control.throughput", {
		properties: {
			percent: { type: "number", minimum: 0, maximum: 100 },
			everyN: { type: "integer", minimum: 1 },
		},
	}),
	constrained("control.loop", {
		required: ["count"],
		properties: { count: { type: "integer", minimum: 1 } },
	}),
	constrained("control.if", {
		required: ["condition"],
		properties: {
			condition: {
				type: "string",
				pattern:
					"^\\s*\\{\\{[^}]+\\}\\}\\s*(==|!=|matches)\\s*\\S.*$|^\\s*\\{\\{[^}]+\\}\\}\\s*exists\\s*$",
			},
		},
	}),
	constrained("extract.regex", {
		properties: { pattern: { type: "string", pattern: "(" } },
	}),
	constrained("assert.status", {
		properties: {
			range: {
				type: "object",
				required: ["min", "max"],
				properties: { min: { type: "integer" }, max: { type: "integer" } },
			},
		},
	}),
	constrained("timer.think", {
		properties: {
			ms: { type: "integer", minimum: 0 },
			gaussian: {
				type: "object",
				required: ["meanMs", "deviationMs"],
				properties: {
					meanMs: { type: "number", minimum: 0 },
					deviationMs: { type: "number", minimum: 0 },
				},
			},
		},
	}),
];

const validate = (kind: string, config: Record<string, unknown>) =>
	validateElementConfig({ kind, config }, CONSTRAINED_KINDS);

describe("validateElementConfig", () => {
	it.each([
		[
			"a cleared required text field",
			"extract.json",
			{ path: "$.a", variable: "" },
			"variable",
			"Can't be empty",
		],
		[
			"a metric name over its length",
			"metric.record",
			{ name: "x".repeat(101) },
			"name",
			"Must be at most 100 characters",
		],
		["a cleared metric name", "metric.record", { name: "" }, "name", "Can't be empty"],
		["a cadence of 0", "timer.pacing", { everyMs: 0 }, "everyMs", "Must be at least 1"],
		[
			"a percent of 150",
			"control.throughput",
			{ percent: 150 },
			"percent",
			"Must be at most 100",
		],
		[
			"a negative percent",
			"control.throughput",
			{ percent: -1 },
			"percent",
			"Must be at least 0",
		],
		["a repeat count of 0", "control.loop", { count: 0 }, "count", "Must be at least 1"],
		[
			"a target rate of 0",
			"timer.throughput",
			{ targetPerMinute: 0 },
			"targetPerMinute",
			"Must be greater than 0",
		],
		[
			"a malformed condition",
			"control.if",
			{ condition: "status == 200" },
			"condition",
			"Use {{var}} == value",
		],
		[
			"a cleared condition",
			"control.if",
			{ condition: "" },
			"condition",
			"Use {{var}} == value",
		],
		[
			"a status range with only min",
			"assert.status",
			{ range: { min: 200 } },
			"range.max",
			"Can't be empty",
		],
		[
			"a status range with only max",
			"assert.status",
			{ range: { max: 299 } },
			"range.min",
			"Can't be empty",
		],
		[
			"a gaussian with only a mean",
			"timer.think",
			{ gaussian: { meanMs: 5 } },
			"gaussian.deviationMs",
			"Can't be empty",
		],
		[
			"a negative gaussian mean",
			"timer.think",
			{ gaussian: { meanMs: -1, deviationMs: 1 } },
			"gaussian.meanMs",
			"Must be at least 0",
		],
		[
			"a nested object two levels down",
			"metric.record",
			{ source: { condition: { field: "status" } } },
			"source.condition.operator",
			"Can't be empty",
		],
	])("flags %s on %s", (_name, kind, config, path, message) => {
		expect(validate(kind, config)).toMatchObject({ [path]: message });
	});

	it("reports every failing field at once, not only the first", () => {
		expect(
			validate("timer.think", { ms: -5, gaussian: { meanMs: -1, deviationMs: -2 } })
		).toEqual({
			ms: "Must be at least 0",
			"gaussian.meanMs": "Must be at least 0",
			"gaussian.deviationMs": "Must be at least 0",
		});
	});

	it.each([
		["extract.json", { path: "$.a", variable: "token" }],
		[
			"metric.record",
			{
				name: "x".repeat(100),
				source: { condition: { field: "f", operator: "eq", value: 1 } },
			},
		],
		["timer.pacing", { everyMs: 1 }],
		["timer.throughput", { targetPerMinute: 0.5 }],
		["control.throughput", { percent: 0 }],
		["control.throughput", { percent: 100 }],
		["control.loop", { count: 1 }],
		["control.if", { condition: "{{env}} == prod" }],
		["control.if", { condition: "{{token}} exists" }],
		["assert.status", { range: { min: 200, max: 299 } }],
		["timer.think", { ms: 0, gaussian: { meanMs: 0, deviationMs: 0 } }],
	])("accepts a valid %s config %j", (kind, config) => {
		expect(validate(kind, config)).toEqual({});
	});

	it("counts a string's length in code points, as the engine does", () => {
		// 60 emoji are 120 UTF-16 units but 60 code points: under maxLength 100.
		expect(validate("metric.record", { name: "\u{1F600}".repeat(60) })).toEqual({});
		expect(validate("metric.record", { name: "\u{1F600}".repeat(101) })).toEqual({
			name: "Must be at most 100 characters",
		});
	});

	it("skips an absent optional property and a missing top-level required key", () => {
		// The latter is `missingRequiredKeys`' chip, never a second report.
		expect(validate("control.throughput", {})).toEqual({});
		expect(validate("timer.pacing", {})).toEqual({});
		expect(validate("assert.status", {})).toEqual({});
	});

	it("does not judge a value of a type the form never writes into that field", () => {
		expect(validate("control.throughput", { percent: true })).toEqual({});
		expect(validate("control.throughput", { percent: Number.NaN })).toEqual({});
		expect(validate("assert.status", { range: "oops" })).toEqual({});
	});

	it("treats a pattern that does not compile as no constraint", () => {
		expect(validate("extract.regex", { pattern: "anything" })).toEqual({});
	});

	it("falls back to a generic hint for a pattern with no written one", () => {
		const kinds = [
			constrained("x.y", { properties: { code: { type: "string", pattern: "^[0-9]+$" } } }),
		];
		expect(validateElementConfig({ kind: "x.y", config: { code: "ab" } }, kinds)).toEqual({
			code: "Doesn't match the expected format",
		});
	});

	it("words a minLength above 1 as a count, since it is not a matter of empty", () => {
		const kinds = [
			constrained("x.y", { properties: { code: { type: "string", minLength: 3 } } }),
		];
		expect(validateElementConfig({ kind: "x.y", config: { code: "ab" } }, kinds)).toEqual({
			code: "Must be at least 3 characters",
		});
	});

	it("has no opinion on a kind the catalogue no longer registers", () => {
		expect(validate("extract.gone", { variable: "" })).toEqual({});
	});
});

describe("errorsWithin", () => {
	const errors = {
		name: "Can't be empty",
		"range.max": "Can't be empty",
		"range.limits.low": "Must be at least 1",
		rangeFinder: "Must be at most 3",
	};

	it("keeps what is under the key, with the key stripped", () => {
		expect(errorsWithin(errors, "range")).toEqual({
			max: "Can't be empty",
			"limits.low": "Must be at least 1",
		});
	});

	it("slices a nested level again with the stripped paths", () => {
		expect(errorsWithin(errorsWithin(errors, "range"), "limits")).toEqual({
			low: "Must be at least 1",
		});
	});

	it("leaves out a field that only shares the key's spelling", () => {
		expect(errorsWithin(errors, "rangeFinder")).toEqual({});
		expect(errorsWithin(errors, "name")).toEqual({});
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

describe("elementNeeds", () => {
	const titled = kindFixture("extract.json", ["variable", "path"], {
		type: "object",
		required: ["variable", "path"],
		properties: {
			variable: { type: "string", title: "Variable name" },
			path: { type: "string" },
		},
	});

	it("names a missing required key by its schema title, and by the key without one", () => {
		expect(elementNeeds({ kind: "extract.json", config: {} }, [titled])).toEqual({
			missing: ["Variable name", "path"],
			invalid: {},
		});
	});

	it("appends the kind's operand phrase after the keys", () => {
		const kinds = [kindFixture("assert.status", ["name"])];
		expect(elementNeeds({ kind: "assert.status", config: {} }, kinds)).toEqual({
			missing: ["name", "accepted codes or a range"],
			invalid: {},
		});
	});

	it("needs the operand alone with no catalogue, the safe direction while it loads", () => {
		expect(elementNeeds({ kind: "assert.status", config: {} }, [])).toEqual({
			missing: ["accepted codes or a range"],
			invalid: {},
		});
		expect(elementNeeds({ kind: "extract.json", config: {} }, [])).toBeNull();
	});

	it("carries a value the schema refuses as invalid, with nothing missing", () => {
		const needs = elementNeeds(
			{ kind: "control.loop", config: { count: 0 } },
			CONSTRAINED_KINDS
		);
		expect(needs).toEqual({ missing: [], invalid: { count: "Must be at least 1" } });
	});

	it("is null for an element that passes", () => {
		expect(
			elementNeeds({ kind: "control.loop", config: { count: 3 } }, CONSTRAINED_KINDS)
		).toBeNull();
		expect(elementNeeds({ kind: "assert.status", config: { in: [200] } }, [])).toBeNull();
	});

	it("does not flag a blank script, which the editor leaves unflagged too", () => {
		const kinds = [kindFixture("script.pre", ["script"])];
		expect(elementNeeds({ kind: "script.pre", config: { script: "" } }, kinds)).toBeNull();
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

	it("is true for an element whose value its schema refuses, though every key is present", () => {
		const elements = [{ id: "1", kind: "control.loop", enabled: true, config: { count: 0 } }];
		expect(hasIncompleteElement(elements, CONSTRAINED_KINDS)).toBe(true);
	});

	it("is false once that value is valid", () => {
		const elements = [{ id: "1", kind: "control.loop", enabled: true, config: { count: 3 } }];
		expect(hasIncompleteElement(elements, CONSTRAINED_KINDS)).toBe(false);
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

/**
 * `parse_json_path` (`engine/src/core/elements/json_path.cpp`) restated; the
 * accepted and refused lists include the cases `elements_registry_test.cpp`
 * pins on the C++ side, so the two stay a hand-compared pair.
 */
const SUPPORTED_PATHS = [
	"$",
	"$.a.b",
	"$..id",
	"$..user-id",
	"$.data.user-id",
	"$['a.b']",
	'$["x"]',
	'$["a b"]',
	"$['a]b']",
	"$['a'].b[0][*]..c",
	"$.items[0]",
	"$.items[-1]",
	"$.items[*].id",
	"$.a b",
	"$[007]",
];

const UNSUPPORTED_PATHS = [
	["no leading $", "foo"],
	["a bare dotted name", "a.b"],
	["an empty path", ""],
	["a trailing dot", "$."],
	["an empty name after a dot", "$.a."],
	["an empty recursive name", "$.."],
	["a filter", "$[?(@.a==1)]"],
	["a filter without a comparison", "$[?(@.a)]"],
	["text after a quoted name", "$['a']x"],
	["an empty quoted name", "$['']"],
	["an unterminated quoted name", "$['a"],
	["a quoted name with no closing bracket", "$['a'"],
	["a bare word in brackets", "$[abc]"],
	["an empty bracket", "$[]"],
	["a signed positive index", "$[+1]"],
	["a padded index", "$[ 1]"],
	["a fractional index", "$[1.5]"],
	["an unclosed bracket", "$.a["],
	["a slice", "$[0:2]"],
	["a character where a step belongs", "$a"],
] as const;

describe("isSupportedJsonPath", () => {
	it.each(SUPPORTED_PATHS)("accepts %s", (path) => {
		expect(isSupportedJsonPath(path)).toBe(true);
	});

	it.each(UNSUPPORTED_PATHS)("refuses %s: %j", (_name, path) => {
		expect(isSupportedJsonPath(path)).toBe(false);
	});
});

describe("validateElementConfig - a JSONPath the engine cannot read", () => {
	const MESSAGE = "Start with $, then use .name, ['name'], [n] or [*]";

	/** Each kind's JSONPath field, as a config that carries only that field. */
	const SITES: [string, string, (path: string) => Record<string, unknown>][] = [
		["assert.jsonpath", "path", (path) => ({ path, exists: true })],
		["extract.json", "path", (path) => ({ path, variable: "token" })],
		["metric.record", "source.jsonpath", (path) => ({ name: "m", source: { jsonpath: path } })],
		[
			"metric.record",
			"source.condition.jsonpath",
			(path) => ({
				name: "m",
				source: {
					condition: { field: "jsonpath", operator: "eq", value: 1, jsonpath: path },
				},
			}),
		],
	];

	describe.each(SITES)("%s at %s", (kind, key, configFor) => {
		it.each(UNSUPPORTED_PATHS)("flags %s", (_name, path) => {
			expect(validate(kind, configFor(path))).toEqual({ [key]: MESSAGE });
		});

		it.each(SUPPORTED_PATHS)("accepts %s", (path) => {
			expect(validate(kind, configFor(path))).toEqual({});
		});

		it("leaves an absent or mistyped path to the schema", () => {
			expect(validate(kind, configFor(undefined as unknown as string))).toEqual({});
			expect(validate(kind, configFor(7 as unknown as string))).toEqual({});
		});
	});

	it("reads a metric condition's path only while its field is jsonpath", () => {
		const condition = (field: string) => ({
			source: { condition: { field, operator: "eq", value: 1, jsonpath: "foo" } },
		});
		expect(validate("metric.record", condition("status"))).toEqual({});
		expect(validate("metric.record", condition("header"))).toEqual({});
		expect(validate("metric.record", condition("jsonpath"))).toEqual({
			"source.condition.jsonpath": MESSAGE,
		});
	});

	it("reads a metric source's path whatever else the source holds", () => {
		// `validate_metric_paths` checks `source.jsonpath` unconditionally.
		expect(validate("metric.record", { source: { jsonpath: "foo", status: true } })).toEqual({
			"source.jsonpath": MESSAGE,
		});
	});

	it("reports both metric paths at once", () => {
		expect(
			validate("metric.record", {
				source: {
					jsonpath: "foo",
					condition: { field: "jsonpath", operator: "eq", value: 1, jsonpath: "bar" },
				},
			})
		).toEqual({ "source.jsonpath": MESSAGE, "source.condition.jsonpath": MESSAGE });
	});

	it("ignores a kind the table does not name", () => {
		expect(validate("extract.regex", { path: "foo" })).toEqual({});
	});

	it("makes hasIncompleteElement true, so the save gate holds the list back", () => {
		const incomplete = (config: Record<string, unknown>) =>
			hasIncompleteElement(
				[{ id: "e1", kind: "extract.json", enabled: true, config }],
				CONSTRAINED_KINDS
			);
		expect(incomplete({ path: "foo", variable: "t" })).toBe(true);
		expect(incomplete({ path: "$.a", variable: "t" })).toBe(false);
	});

	it("names every site the tests above drive", () => {
		// A table entry with no case here would be restated and never checked.
		expect(JSON_PATH_FIELDS.map((f) => `${f.kind} ${f.path.join(".")}`).sort()).toEqual(
			SITES.map(([kind, key]) => `${kind} ${key}`).sort()
		);
	});
});
