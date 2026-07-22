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

/** Matches `{{name}}`, capturing the variable name (without braces). */
export const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

/** For String.split: capturing group keeps the `{{name}}` tokens in output. */
export const VARIABLE_SPLIT_PATTERN = /(\{\{[^{}]+\}\})/g;

/** True when the whole string is a single `{{name}}` token. */
export function isVariableToken(text: string): boolean {
	return /^\{\{[^{}]+\}\}$/.test(text);
}
