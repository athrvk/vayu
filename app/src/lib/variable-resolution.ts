/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The pure core of `{{variable}}` resolution, as the renderer *previews* it.
 *
 * Since issue #226 the engine owns execution-time resolution (`POST /compose`
 * - interpolation, precedence, the `inherit` auth walk). What the renderer
 * keeps is preview: resolved-URL tab titles, key/value and body previews, the
 * unresolved-token painting, and the "why this value" popover. A preview that
 * disagrees with what the engine will send is worse than none, so this module
 * restates the engine's rules exactly and is held to them by the shared
 * conformance fixture (`engine/tests/fixtures/variable-resolution-conformance
 * .json`), which the engine's gtest suite and this module's vitest suite both
 * drive.
 *
 * The rules (issue #226, "Behaviour that must not change" + D17):
 *  - precedence: environment > collection chain (leaf over root) > globals
 *  - a definition is disabled only by an explicit `enabled: false`; absent or
 *    malformed counts as enabled (D17 - matches the importers and the engine)
 *  - a non-string stored `value` reads as "" (D17)
 *  - unknown plain name resolves to ""; unknown `$name` keeps its braces
 *  - a `data.*` name keeps its braces too: it addresses the reserved data
 *    namespace (issue #402), which only a scenario run's iteration can bind
 *  - a user-defined variable named `$guid` beats the generator; generators run
 *    once per occurrence
 *  - single pass, no recursion; the raw string, never the typed value
 *
 * The `{{name}}` matcher itself is `VARIABLE_PATTERN` from
 * `constants/variables.ts` - this module used to declare its own identical
 * copy, which is how the app came to hold four (issue #227).
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { isDynamicVariableName, resolveDynamicVariable } from "./dynamic-variables";

/** A stored variable definition as it may actually arrive off disk - loose. */
export interface StoredVariableLike {
	value?: unknown;
	enabled?: unknown;
}

/** `Record<name, definition>` - the shape of every stored `variables` blob. */
export type StoredVariableBag = Record<string, StoredVariableLike>;

/**
 * D17: only an explicit `false` disables a definition. Absent (a blob written
 * by the raw engine API) and malformed values count as enabled, matching the
 * importers' normalization and the engine's `parse_variables`.
 */
export function isEnabledDefinition(def: StoredVariableLike | undefined): boolean {
	return !!def && typeof def === "object" && def.enabled !== false;
}

/**
 * D17: the raw stored string substitutes; a non-string stored `value` reads as
 * "" rather than being stringified (`42` printing as "42" in one client and
 * `undefined` printing as "undefined" in another is how this divergence was
 * found).
 */
export function coerceVariableValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Build the effective variable map with the app's precedence (highest wins):
 * environment > collection chain (leaf over root) > globals. `chain` is
 * root-first, so later (leaf) entries overwrite earlier (root) ones.
 */
export function buildVariableValues(scopes: {
	globals?: StoredVariableBag;
	chain?: StoredVariableBag[];
	environment?: StoredVariableBag;
}): Map<string, string> {
	const map = new Map<string, string>();
	const collect = (bag: StoredVariableBag | undefined) => {
		if (!bag || typeof bag !== "object") return;
		for (const [name, def] of Object.entries(bag)) {
			if (isEnabledDefinition(def)) map.set(name, coerceVariableValue(def.value));
		}
	};
	collect(scopes.globals); // 1. globals (lowest)
	for (const bag of scopes.chain ?? []) collect(bag); // 2. chain root->leaf
	collect(scopes.environment); // 3. environment (highest)
	return map;
}

/**
 * The reserved prefix for the data namespace (issue #402). `{{data.column}}`
 * addresses a column of a collection run's data set, never a variable.
 */
export const DATA_NAMESPACE_PREFIX = "data.";

/**
 * True for a name inside the reserved `data.*` namespace.
 *
 * The namespace sits *outside* the tier order rather than above it, so a
 * variable someone happens to name `data.id` and the column `{{data.id}}` are
 * different names and cannot collide. The prefix alone (`{{data.}}`) names no
 * column, so it is not reserved - it follows the ordinary unknown-name rule.
 */
export function isDataVariableName(name: string): boolean {
	return name.length > DATA_NAMESPACE_PREFIX.length && name.startsWith(DATA_NAMESPACE_PREFIX);
}

/**
 * The column a `data.*` name addresses, or null for a name outside the
 * namespace.
 *
 * One place strips the prefix, rather than a `slice(5)` in the painter, another
 * in the audit and a third in the completion providers - each of which would
 * have to re-derive the boundary `isDataVariableName` already draws.
 */
export function dataColumnName(name: string): string | null {
	return isDataVariableName(name) ? name.slice(DATA_NAMESPACE_PREFIX.length) : null;
}

/**
 * Substitute `{{name}}` occurrences in one pass: the reserved `data.*`
 * namespace first (kept verbatim), then scopes, then the dynamic-variable
 * table. A defined name (even one spelled `$guid`) wins over a generator; an
 * unknown `$name` keeps its braces (issue #186); an ordinary unknown name
 * becomes "". Replacements are never rescanned, so a value containing
 * `{{other}}` stays literal.
 */
export function resolveTemplate(
	input: string,
	lookup: (name: string) => string | undefined
): string {
	if (!input || typeof input !== "string") return input;
	return input.replace(VARIABLE_PATTERN, (match, rawName: string) => {
		const name = rawName.trim();
		// Before the lookup, not after: the namespace is disjoint from the
		// scopes, so a variable named `data.id` must not answer for the column.
		// Only a scenario run's iteration can bind one, and the engine's
		// composer leaves it written as it stands for exactly that reason.
		if (isDataVariableName(name)) return match;
		const defined = lookup(name);
		if (defined !== undefined) return defined;
		if (isDynamicVariableName(name)) return resolveDynamicVariable(name) ?? match;
		return "";
	});
}
