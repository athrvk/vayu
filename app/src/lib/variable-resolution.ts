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
 *  - a user-defined variable named `$guid` beats the generator; generators run
 *    once per occurrence
 *  - single pass, no recursion; the raw string, never the typed value
 */

import { isDynamicVariableName, resolveDynamicVariable } from "./dynamic-variables";

/** Matches `{{name}}` - no nested braces, no escape hatch. */
export const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

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
 * Substitute `{{name}}` occurrences in one pass: scopes first, then the
 * dynamic-variable table. A defined name (even one spelled `$guid`) wins over
 * a generator; an unknown `$name` keeps its braces (issue #186); an ordinary
 * unknown name becomes "". Replacements are never rescanned, so a value
 * containing `{{other}}` stays literal.
 */
export function resolveTemplate(
	input: string,
	lookup: (name: string) => string | undefined
): string {
	if (!input || typeof input !== "string") return input;
	return input.replace(VARIABLE_PATTERN, (match, rawName: string) => {
		const name = rawName.trim();
		const defined = lookup(name);
		if (defined !== undefined) return defined;
		if (isDynamicVariableName(name)) return resolveDynamicVariable(name) ?? match;
		return "";
	});
}
