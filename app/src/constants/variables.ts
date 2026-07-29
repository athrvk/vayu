/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variable interpolation syntax: `{{variableName}}`.
 *
 * Shared regexes are global; only use them with APIs that reset lastIndex
 * (String.replace / split / matchAll). For boolean checks use
 * `isVariableToken` - `.test()` on a shared global regex is stateful.
 */

import type { VariableScope } from "@/types";

/** Matches `{{name}}`, capturing the variable name (without braces). */
export const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

/** For String.split: capturing group keeps the `{{name}}` tokens in output. */
export const VARIABLE_SPLIT_PATTERN = /(\{\{[^{}]+\}\})/g;

/** True when the whole string is a single `{{name}}` token. */
export function isVariableToken(text: string): boolean {
	return /^\{\{[^{}]+\}\}$/.test(text);
}

/**
 * One label and one colour per scope, for every surface that names a scope.
 *
 * Read by `VariableScopeBadge` and by the variable popover, which needs the same
 * labels for its "create in" picker and the same colours for its list of
 * definitions that lost. It lived inside the badge component until the popover
 * needed it too - re-deriving it inline in a second branch is a mistake this
 * codebase has already made once (`SCOPE_CONFIG.global`), and the fix then was
 * to have one definition rather than two that agree by luck.
 *
 * Here rather than exported from the badge because a module that exports both a
 * component and a constant loses React Fast Refresh.
 *
 * `--scope-*` are real tokens, green/orange/blue in both themes, and
 * `docs/design-system.md` gives them the "icon/text solid, `/10` tint"
 * convention the classes below follow.
 */
export const VARIABLE_SCOPE_CONFIG: Record<
	VariableScope,
	{ compact: string; full: string; tint: string; border: string }
> = {
	global: {
		compact: "G",
		full: "Global",
		tint: "bg-scope-global/10 text-scope-global",
		border: "border-scope-global/30",
	},
	collection: {
		compact: "C",
		full: "Collection",
		tint: "bg-scope-collection/10 text-scope-collection",
		border: "border-scope-collection/30",
	},
	environment: {
		compact: "E",
		full: "Environment",
		tint: "bg-scope-environment/10 text-scope-environment",
		border: "border-scope-environment/30",
	},
};

/** The dot colour for a scope, used where a full badge would be too heavy. */
export const VARIABLE_SCOPE_DOT: Record<VariableScope, string> = {
	global: "bg-scope-global",
	collection: "bg-scope-collection",
	environment: "bg-scope-environment",
};
