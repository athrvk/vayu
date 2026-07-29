/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

const SIMPLE_VAR = /\{\{\s*([\w.$-]+)\s*\}\}/g; // {{ x }} / {{ _.x }} - identifier only
const PATH_TEMPLATE = /\{([\w$-]+)\}/g; // {x} single-brace, not already {{x}}

export interface NormalizeVarsOptions {
	/**
	 * Rewrite single-brace `{x}` as a Vayu `{{x}}` variable.
	 *
	 * True only for OpenAPI/Swagger, where `{x}` *is* the path-template syntax.
	 * Postman and Insomnia template with `{{x}}` alone, so there a single brace is
	 * literal text - `fields=friends{name}`, a path segment `/tags/{beta}` - and
	 * rewriting it invents a variable reference that resolves to nothing at
	 * execution. Off by default: a rewrite that changes what gets sent has to be
	 * asked for by the format that needs it.
	 */
	pathTemplates?: boolean;
}

/**
 * Normalize foreign template syntax to Vayu `{{var}}`.
 * - `{{ x }}` / `{{ _.x }}` → `{{x}}`
 * - OpenAPI `{x}` → `{{x}}`, only with `pathTemplates`
 * - Nunjucks `{% tag %}` and filtered `{{ x | f }}` are left verbatim (no Vayu equivalent).
 */
export function normalizeVars(input: string, opts: NormalizeVarsOptions = {}): string {
	if (!input) return input;
	// 1. Tighten/clean simple {{...}} vars (filters contain `|` and won't match \w, so skipped).
	let out = input.replace(SIMPLE_VAR, (_m, name: string) => `{{${name.replace(/^_\./, "")}}}`);
	if (!opts.pathTemplates) return out;
	// 2. Convert single-brace path params, but not the {{...}} we just produced.
	out = out.replace(PATH_TEMPLATE, (m, name: string, offset: number, str: string) => {
		const before = str[offset - 1];
		const after = str[offset + m.length];
		if (before === "{" || after === "}") return m; // part of a {{...}} pair
		return `{{${name}}}`;
	});
	return out;
}
