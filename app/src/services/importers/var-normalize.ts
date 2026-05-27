/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

const SIMPLE_VAR = /\{\{\s*([\w.$-]+)\s*\}\}/g; // {{ x }} / {{ _.x }} — identifier only
const OPENAPI_PATH = /\{([\w$-]+)\}/g; // {x} single-brace, not already {{x}}

/**
 * Normalize foreign template syntax to Vayu `{{var}}`.
 * - `{{ x }}` / `{{ _.x }}` → `{{x}}`
 * - OpenAPI `{x}` → `{{x}}`
 * - Nunjucks `{% tag %}` and filtered `{{ x | f }}` are left verbatim (no Vayu equivalent).
 */
export function normalizeVars(input: string): string {
	if (!input) return input;
	// 1. Tighten/clean simple {{...}} vars (filters contain `|` and won't match \w, so skipped).
	let out = input.replace(SIMPLE_VAR, (_m, name: string) => `{{${name.replace(/^_\./, "")}}}`);
	// 2. Convert single-brace OpenAPI params, but not the {{...}} we just produced.
	out = out.replace(OPENAPI_PATH, (m, name: string, offset: number, str: string) => {
		const before = str[offset - 1];
		const after = str[offset + m.length];
		if (before === "{" || after === "}") return m; // part of a {{...}} pair
		return `{{${name}}}`;
	});
	return out;
}
