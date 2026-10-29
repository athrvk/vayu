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

import type { ElementDef, ElementKindSchema } from "@/types";

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
 * The `required` keys of an element's kind that its own `config` is missing
 * outright (issue #1635) - presence only, not `minLength`/`minimum`. That
 * matches what `addElement`'s fresh `config: {}` produces exactly (no key at
 * all), which is cheap and exact for the "just created it" case without
 * duplicating the engine's fuller JSON Schema validation client-side; the
 * engine's own `PUT` still owns every other constraint.
 */
export function missingRequiredKeys(
	element: Pick<ElementDef, "kind" | "config">,
	kinds: ElementKindSchema[]
): string[] {
	const required = kinds.find((k) => k.kind === element.kind)?.configSchema.required ?? [];
	return required.filter((key) => element.config[key] === undefined);
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
 * (issue #1635) or its kind's "one of" operand (#3043) - the shapes that 400
 * the *entire* `elements` array on save, not only that one element's own edit,
 * because the array is sent whole whenever it is touched (`buildUpdatePayload`).
 */
export function hasIncompleteElement(elements: ElementDef[], kinds: ElementKindSchema[]): boolean {
	return elements.some(
		(el) => missingRequiredKeys(el, kinds).length > 0 || missingOperand(el) !== null
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
