/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which variable names a script mentions.
 *
 * Two syntaxes, because a script can reach a variable either way: the `pm` API
 * (`pm.environment.get("token")`) and a `{{token}}` template, which the engine
 * does not interpolate inside a script but authors write anyway when building
 * a URL or body string.
 *
 * Pulled out of the panel so it can be tested as logic. It was inline in both
 * script panels, twice over, with the regexes rebuilt on every render.
 */

/** `pm.environment.get("x")`, and the globals / collectionVariables siblings. */
const PM_GET = /pm\.(?:environment|globals|collectionVariables)\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** `{{x}}`. Inner braces excluded, so `{{a}}{{b}}` is two names and not one. */
const TEMPLATE = /\{\{([^{}]+)\}\}/g;

/**
 * Names, deduplicated: every `pm` reference in source order, then every
 * template reference in source order.
 *
 * Grouped by syntax rather than by position in the script - which is what the
 * two panels did, and is kept deliberately so this stays a refactor. It is
 * worth knowing rather than assuming: the panel chips the first five and
 * counts the rest, so adding a `pm.globals.get()` below an existing `{{name}}`
 * pushes that name down the list even though it comes first in the file.
 */
export function referencedVariables(script: string): string[] {
	const names = [
		...[...script.matchAll(PM_GET)].map((m) => m[1]),
		...[...script.matchAll(TEMPLATE)].map((m) => m[1].trim()),
	];
	return [...new Set(names.filter((n) => n.length > 0))];
}
