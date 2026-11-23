/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The element properties the engine reads `{{name}}` / `{{data.column}}` in at
 * run time (#3779), and so the ones whose form field is a variable-aware input
 * that paints the token instead of a plain text box.
 *
 * Kept beside, not inside, `GenericElementForm`, which knows no kinds: this is
 * the one table that says which field of which kind is resolved, the way
 * `element-modes.ts` is the one table of which key belongs to which strategy.
 * A field missing here is not resolved by the engine either, so painting a
 * token in it would promise a substitution that never happens.
 */

type Config = Record<string, unknown>;

/** Whether the property `name`, at the top level of `config`, is resolved when the element runs. */
type ResolvesAt = (name: string, config: Config) => boolean;

const RESOLVED_FIELDS: Record<string, ResolvesAt> = {
	// `AssertContainsElement` (assert_kinds.cpp) resolves `text` in `contains`
	// and `equals`; in `matches` it is compiled as a pattern, and a `{{` there
	// is regex syntax, never a token. `mode` absent is the schema's default,
	// `contains`.
	"assert.contains": (name, config) => name === "text" && config.mode !== "matches",
	// `AssertJsonPathElement` resolves every string inside `expected`. `regex`
	// is a pattern and is never resolved.
	"assert.jsonpath": (name) => name === "expected",
};

/** Whether the engine resolves variables in this kind's top-level property, given the config it is in. */
export function resolvesVariables(kind: string, name: string, config: Config): boolean {
	return RESOLVED_FIELDS[kind]?.(name, config) ?? false;
}
