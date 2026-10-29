/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Small, context-free reads over an `ElementDef[]` list (issue #1512), and
 * `SaveBlockedError` (issue #1635) - the same save-path contract both a
 * request's autosave and a collection's manual save button need - shared by
 * the request-builder module, the collections module and the generic
 * reference scanners in `lib/` - none of which may depend on each other, so
 * this lives in `lib/` rather than under any one of them.
 */

import type {
	ElementConfigProperty,
	ElementConfigSchema,
	ElementDef,
	ElementKindSchema,
} from "@/types";

/**
 * The joined text of every enabled element of one script kind (`script.pre`
 * or `script.post`) in a list - what a pre-request-script presence check
 * (`LoadTestConfigDialog`'s warning) and the variable-reference scanners
 * (`ColumnAudit`, `column-audit.ts`, `request-references.ts`) need: one flat
 * string per entity rather than the element list itself.
 *
 * Joined with the engine's own separator (`"\n\n"`,
 * `RunContext::compile_step_elements`) so it reproduces what a load run's
 * deferred replay runs when more than one `script.post` element defers - the
 * common case is exactly one such element, and this degrades sensibly for
 * more than one rather than silently dropping every part past the first.
 */
export function scriptTextFor(
	elements: ElementDef[],
	kind: "script.pre" | "script.post"
): string | undefined {
	const scripts = elements
		.filter((el) => el.kind === kind && el.enabled)
		.map((el) => el.config.script)
		.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
	return scripts.length > 0 ? scripts.join("\n\n") : undefined;
}

/**
 * Whether a `script.pre`/`script.post` element's own text is empty or
 * whitespace-only - the shared rule for "absent for every purpose but
 * storage" (#1609): not composed, not run, not reported, not counted toward
 * an inherited-elements notice. A blank element still exists as a stored row
 * (a user may be mid-edit); only its runtime effect is inert.
 */
export function isBlankScriptElement(el: Pick<ElementDef, "kind" | "config">): boolean {
	if (el.kind !== "script.pre" && el.kind !== "script.post") return false;
	const text = el.config.script;
	return typeof text !== "string" || text.trim().length === 0;
}

/**
 * The top-level `required` keys of an element's kind that its own `config` is
 * missing outright (issue #1635) - presence only. That matches what
 * `addElement`'s fresh `config: {}` produces exactly (no key at all) and is
 * what the row's "Needs ..." chip names. The value constraints (`minLength`,
 * `minimum`, a missing nested key, ...) are `validateElementConfig`'s, which
 * leaves a missing top-level key to this function so the two never report the
 * same field.
 */
export function missingRequiredKeys(
	element: Pick<ElementDef, "kind" | "config">,
	kinds: ElementKindSchema[]
): string[] {
	const required = kinds.find((k) => k.kind === element.kind)?.configSchema.required ?? [];
	return required.filter((key) => element.config[key] === undefined);
}

/**
 * The hint a failed `pattern` shows in place of the generic one, keyed by
 * `<kind>.<config key path>`. A pattern is not a sentence a user can act on;
 * `element-kinds.conformance.test.tsx` holds every key here to a pattern the
 * live catalogue declares.
 */
export const PATTERN_HINTS: Readonly<Record<string, string>> = {
	"control.if.condition": "Use {{var}} == value",
};

const GENERIC_PATTERN_HINT = "Doesn't match the expected format";
const EMPTY_HINT = "Can't be empty";

function matchesPattern(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		// A pattern this engine's JS cannot compile is no constraint: the
		// engine's own validation still has the last word.
		return true;
	}
}

function stringProblem(
	value: string,
	property: ElementConfigProperty,
	hintKey: string
): string | null {
	const { minLength, maxLength, pattern } = property;
	if (minLength !== undefined && value.length < minLength) {
		return minLength <= 1 ? EMPTY_HINT : `Must be at least ${minLength} characters`;
	}
	if (maxLength !== undefined && value.length > maxLength) {
		return `Must be at most ${maxLength} characters`;
	}
	if (pattern !== undefined && !matchesPattern(pattern, value)) {
		return PATTERN_HINTS[hintKey] ?? GENERIC_PATTERN_HINT;
	}
	return null;
}

function numberProblem(value: number, property: ElementConfigProperty): string | null {
	const { minimum, exclusiveMinimum, maximum } = property;
	if (minimum !== undefined && value < minimum) return `Must be at least ${minimum}`;
	if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
		return `Must be greater than ${exclusiveMinimum}`;
	}
	if (maximum !== undefined && value > maximum) return `Must be at most ${maximum}`;
	return null;
}

function valueProblem(value: unknown, property: ElementConfigProperty, hintKey: string) {
	if (typeof value === "string") return stringProblem(value, property, hintKey);
	if (typeof value === "number" && Number.isFinite(value)) return numberProblem(value, property);
	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `path` is inside the JSONPath subset the engine evaluates. Restates
 * `parse_json_path` (`engine/src/core/elements/json_path.cpp`) step for step:
 * `$`, then any run of `.name` / `..name` (a non-empty name running to the next
 * `.` or `[`), `['name']` / `["name"]` (a non-empty name running to the next
 * matching quote, which must be followed by `]`), `[n]` (a whole base-10
 * integer, `-` allowed, no `+` or space) and `[*]`. A filter or any other
 * character is refused. A change to the C++ needs a hand edit here: no test
 * can read it, only `JSON_PATH_FIELDS` is held to the live catalogue.
 */
export function isSupportedJsonPath(path: string): boolean {
	if (!path.startsWith("$")) return false;
	let i = 1;
	while (i < path.length) {
		const next =
			path[i] === "."
				? memberStepEnd(path, i)
				: path[i] === "["
					? bracketStepEnd(path, i)
					: -1;
		if (next < 0) return false;
		i = next;
	}
	return true;
}

/** Where a `.name` / `..name` step starting at `path[i]` ends, or -1 for an empty name. */
function memberStepEnd(path: string, i: number): number {
	const nameStart = path[i + 1] === "." ? i + 2 : i + 1;
	let end = nameStart;
	while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
	return end === nameStart ? -1 : end;
}

/** Where a `[...]` step starting at `path[i]` ends, or -1 when it is not one the engine reads. */
function bracketStepEnd(path: string, i: number): number {
	const quote = path[i + 1];
	if (quote === "'" || quote === '"') {
		const nameEnd = path.indexOf(quote, i + 2);
		const closed = nameEnd > i + 2 && path[nameEnd + 1] === "]";
		return closed ? nameEnd + 2 : -1;
	}
	const close = path.indexOf("]", i);
	if (close < 0) return -1;
	const inner = path.slice(i + 1, close);
	return inner === "*" || /^-?\d+$/.test(inner) ? close + 1 : -1;
}

interface JsonPathField {
	kind: string;
	/** Config key path to the string, `["source", "condition", "jsonpath"]`. */
	path: readonly string[];
	/**
	 * The engine reads the path only while a sibling holds a value
	 * (`metric.record`'s condition path, when its `field` is `jsonpath`); a
	 * stale one beside another field is not refused.
	 */
	onlySiblingEquals?: { key: string; value: string };
}

const JSON_PATH_MESSAGE = "Start with $, then use .name, ['name'], [n] or [*]";

/**
 * Every config string the engine reads as a JSONPath and refuses when it is
 * malformed (`json_path_problem`, called from `assert_jsonpath_problem`,
 * `extract_json_problem` and `validate_metric_paths`). The schema says only
 * `type: string` for these, so this table restates the C++ rule beside
 * `OPERAND_RULES`; `element-kinds.conformance.test.tsx` holds every entry to a
 * property the live catalogue declares, but a path the C++ starts to check
 * needs a hand edit here.
 */
export const JSON_PATH_FIELDS: readonly JsonPathField[] = [
	{ kind: "assert.jsonpath", path: ["path"] },
	{ kind: "extract.json", path: ["path"] },
	{ kind: "metric.record", path: ["source", "jsonpath"] },
	{
		kind: "metric.record",
		path: ["source", "condition", "jsonpath"],
		onlySiblingEquals: { key: "field", value: "jsonpath" },
	},
];

function valueAt(config: Record<string, unknown>, path: readonly string[]) {
	return path.reduce<unknown>(
		(node, key) => (isPlainObject(node) ? node[key] : undefined),
		config
	);
}

function collectJsonPathErrors(
	kind: string,
	config: Record<string, unknown>,
	errors: Record<string, string>
): void {
	for (const field of JSON_PATH_FIELDS) {
		if (field.kind !== kind) continue;
		const value = valueAt(config, field.path);
		// Absent or mistyped is the schema's to report, as in `json_path_problem`.
		if (typeof value !== "string" || isSupportedJsonPath(value)) continue;
		const { onlySiblingEquals } = field;
		if (onlySiblingEquals) {
			const sibling = valueAt(config, [...field.path.slice(0, -1), onlySiblingEquals.key]);
			if (sibling !== onlySiblingEquals.value) continue;
		}
		errors[field.path.join(".")] = JSON_PATH_MESSAGE;
	}
}

/**
 * Walks one schema level. `nested` levels also report a missing `required` key:
 * at the top level that is `missingRequiredKeys`' chip, but a nested object
 * (`assert.status.range` with only `min`) has no chip to carry it.
 */
function collectConfigErrors(
	schema: ElementConfigSchema | ElementConfigProperty,
	config: Record<string, unknown>,
	path: readonly string[],
	kind: string,
	errors: Record<string, string>
): void {
	const prefix = path.length > 0 ? `${path.join(".")}.` : "";
	if (path.length > 0) {
		for (const key of schema.required ?? []) {
			if (config[key] === undefined) errors[prefix + key] = EMPTY_HINT;
		}
	}
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		const value = config[name];
		if (!property || value === undefined) continue;
		const keyPath = prefix + name;
		if (property.type === "object" && isPlainObject(value)) {
			collectConfigErrors(property, value, [...path, name], kind, errors);
			continue;
		}
		const problem = valueProblem(value, property, `${kind}.${keyPath}`);
		if (problem) errors[keyPath] = problem;
	}
}

/**
 * Every config field of an element that breaks its kind's schema, keyed by dot
 * path (`range.max` for a nested one) with one short message each (#3048). The
 * engine refuses an element on the first problem it finds; this reports all of
 * them, so each field can say what is wrong with it.
 *
 * Covers the keywords the live catalogue uses and nothing more: `minLength`,
 * `maxLength`, `minimum`, `exclusiveMinimum`, `maximum`, `pattern`, and a
 * nested `required` (`element-kinds.conformance.test.tsx` fails when the
 * catalogue gains another). `type` and `enum` are not judged - the form's
 * controls write those. An absent property is skipped, and so is a top-level
 * `required` key that is absent (`missingRequiredKeys`' to report). A JSONPath
 * the engine cannot read (`JSON_PATH_FIELDS`) is reported too, though no schema
 * keyword says so.
 */
export function validateElementConfig(
	element: Pick<ElementDef, "kind" | "config">,
	kinds: ElementKindSchema[]
): Record<string, string> {
	const errors: Record<string, string> = {};
	const entry = kinds.find((k) => k.kind === element.kind);
	if (!entry) return errors;
	collectConfigErrors(entry.configSchema, element.config, [], element.kind, errors);
	collectJsonPathErrors(element.kind, element.config, errors);
	return errors;
}

/**
 * The slice of a {@link validateElementConfig} result that belongs to the
 * nested object at `key`, with `key.` stripped - what a form hands the form of
 * that object so every level looks up its own fields by their own names.
 */
export function errorsWithin(
	errors: Readonly<Record<string, string>>,
	key: string
): Record<string, string> {
	const prefix = `${key}.`;
	return Object.fromEntries(
		Object.entries(errors)
			.filter(([path]) => path.startsWith(prefix))
			.map(([path, message]) => [path.slice(prefix.length), message])
	);
}

/**
 * A kind whose engine-side `validate_config` refuses a config the schema
 * accepts, because it names no operand the kind could act on (#3043, #3055).
 * JSON Schema cannot say "one of", so the catalogue does not carry the rule;
 * this table restates it, and `element-kinds.conformance.test.tsx` holds every
 * name here to a property the live catalogue declares. That guard cannot see
 * the C++ rule itself: a change to `assert_status_problem`,
 * `assert_jsonpath_problem`, `control_throughput_problem`, `timer_think_problem`
 * or `assert_contains_problem` needs a hand edit here. A rule gates on the
 * operand being missing; a mix the engine also refuses (`percent` beside
 * `everyN`, `exists` beside `expected`) is one the mode picker never writes, and
 * reaches the row through the engine's own refusal (`parseElementRefusal`).
 */
interface OperandRule {
	/** The config keys the rule reads; checked against the catalogue. */
	properties: readonly string[];
	/**
	 * Set when the schema already `required`s the properties and the rule
	 * judges their value instead (`assert.contains`' `text`, which a cleared
	 * field leaves as `""`).
	 */
	judgesValue?: true;
	/** What the row's "Needs ..." chip asks for. */
	needs: string;
	isMet: (config: Record<string, unknown>) => boolean;
}

const hasKey = (config: Record<string, unknown>, key: string) => config[key] !== undefined;

const JSONPATH_OPERANDS = ["expected", "regex", "exists"] as const;

export const OPERAND_RULES: Readonly<Record<string, OperandRule>> = {
	// `assert_status_problem`: a non-empty `in` array, or a `range` key. An
	// emptied `in` list is `[]`, which the engine refuses like an absent one.
	"assert.status": {
		properties: ["in", "range"],
		needs: "accepted codes or a range",
		isMet: (config) =>
			(Array.isArray(config.in) && config.in.length > 0) || hasKey(config, "range"),
	},
	// `assert_jsonpath_problem`: any of the three keys present, whatever its value
	// (the form writes one at a time; the engine also refuses `exists` beside
	// `expected` or `regex`, #3049).
	"assert.jsonpath": {
		properties: JSONPATH_OPERANDS,
		needs: "a value, pattern or existence check",
		isMet: (config) => JSONPATH_OPERANDS.some((key) => hasKey(config, key)),
	},
	// `control_throughput_problem`: exactly one of the two; the mode picker
	// writes one at a time, so only "neither" can occur from the form.
	"control.throughput": {
		properties: ["percent", "everyN"],
		needs: "a percent or an every-Nth count",
		isMet: (config) => hasKey(config, "percent") || hasKey(config, "everyN"),
	},
	// `timer_think_problem`: `ms`, a `gaussian` object, or both bounds of the
	// random range. A lone bound is refused, so the row says so mid-edit.
	"timer.think": {
		properties: ["ms", "minMs", "maxMs", "gaussian"],
		needs: "a fixed wait, both range bounds or a gaussian",
		isMet: (config) =>
			hasKey(config, "ms") ||
			hasKey(config, "gaussian") ||
			(hasKey(config, "minMs") && hasKey(config, "maxMs")),
	},
	// `assert_contains_problem`: `contains` (the default mode) with an empty
	// `text`. `equals` and `matches` read an empty text as a value, and an
	// absent `text` is `missingRequiredKeys`' to report.
	"assert.contains": {
		properties: ["text", "mode"],
		judgesValue: true,
		needs: "text to look for",
		isMet: (config) =>
			(config.mode !== undefined && config.mode !== "contains") || config.text !== "",
	},
};

/**
 * What an element still needs for want of its kind's "one of" operand
 * (`OPERAND_RULES`), or `null` when it has one or its kind has no such rule.
 * Kept apart from `missingRequiredKeys` because it names no config key: the
 * fix is to fill any one of several.
 */
export function missingOperand(element: Pick<ElementDef, "kind" | "config">): string | null {
	const rule = OPERAND_RULES[element.kind];
	if (!rule || rule.isMet(element.config)) return null;
	return rule.needs;
}

/**
 * Whether any element in the list is missing a required config key outright
 * (issue #1635), its kind's "one of" operand (#3043) or holds a value its schema
 * refuses (#3048) - the shapes that 400 the *entire* `elements` array on save,
 * not only that one element's own edit, because the array is sent whole
 * whenever it is touched (`buildUpdatePayload`).
 */
export function hasIncompleteElement(elements: ElementDef[], kinds: ElementKindSchema[]): boolean {
	return elements.some(
		(el) =>
			missingRequiredKeys(el, kinds).length > 0 ||
			missingOperand(el) !== null ||
			Object.keys(validateElementConfig(el, kinds)).length > 0
	);
}

/** The engine's refusal of one element: `'<Kind label>' (item N): <problem>`. */
const ELEMENT_REFUSAL = /^'[^']*' \(item (\d+)\): ([\s\S]+)$/;

/**
 * The element an engine 400 names, and the problem it states (#3043).
 *
 * `N` is the 1-based index into the `elements` array that was sent, so the
 * caller passes that same array. Anything that does not read this way - an
 * older engine's wording, a message about a different field, an index past the
 * array - answers `null`, and the caller keeps its generic save failure.
 */
export function parseElementRefusal(
	message: string,
	sent: readonly ElementDef[]
): { element: ElementDef; problem: string } | null {
	const match = ELEMENT_REFUSAL.exec(message);
	if (!match) return null;
	const element = sent[Number(match[1]) - 1];
	return element ? { element, problem: match[2] } : null;
}

/**
 * Thrown by a save callback to mean "nothing was sent, and nothing should be
 * retried" (issue #1635) - a payload the caller already knows the server
 * will refuse (an incomplete element, per `hasIncompleteElement`), as
 * opposed to a save that was attempted and failed. Both save paths -
 * `useSaveManager`'s autosave and `useDraftSaveContext`'s manual-button
 * model - read this type to report "still dirty, nothing in flight" rather
 * than a genuine failure; neither retries against a payload that will not
 * have changed by the next attempt.
 */
export class SaveBlockedError extends Error {
	constructor(message = "Save blocked: fix the incomplete field first") {
		super(message);
		this.name = "SaveBlockedError";
	}
}
