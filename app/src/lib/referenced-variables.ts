/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which variable names a script mentions, and by which syntax.
 *
 * Two syntaxes, because a script can *name* a variable either way - but only
 * one of them reads it. `pm.environment.get("token")` resolves at run time;
 * `{{token}}` inside script text is literal characters, because the engine
 * never interpolates a script (`request_composer.cpp`, decision D16 - rewriting
 * `{{...}}` there cannot tell a string literal from code). Authors write it
 * anyway, out of habit from URLs and bodies, which is exactly why the surfaces
 * that chip these names have to keep the two apart (issue #659 item 3).
 *
 * Pulled out of the panel so it can be tested as logic. It was inline in both
 * script panels, twice over, with the regexes rebuilt on every render - and a
 * *third* time in the collection's script tab, which is why this now lives in
 * `lib/` rather than under `request-builder/`: it is read by two modules, and
 * a copy under one of them is what let the collection tab keep its own.
 *
 * The template matcher is the app's one `VARIABLE_PATTERN`; only `PM_GET` is
 * local, because nothing else looks for that syntax. Inner braces are excluded
 * by that pattern, so `{{a}}{{b}}` is two names and not one.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";

/** `pm.environment.get("x")`, and the globals / collectionVariables siblings. */
const PM_GET = /pm\.(?:environment|globals|collectionVariables)\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * How a script named a variable.
 *
 * - `pm` - a `pm.*.get()` call. The script really reads the variable, so
 *   "defined" and "not defined" are both meaningful answers about it.
 * - `template` - a `{{name}}` in the script text. Nothing substitutes it, so no
 *   answer about whether the name resolves says anything true about this
 *   script.
 */
export type ReferenceSyntax = "pm" | "template";

/**
 * What a `template` chip has to say for itself, in both script surfaces.
 *
 * Here rather than in either panel because the two would otherwise each own a
 * sentence about the same engine rule, and the repo has been bitten by exactly
 * that: a copy does not receive the original's corrections. It is the one string
 * in this module, and it belongs to the syntax the module distinguishes.
 */
export const TEMPLATE_IN_SCRIPT_NOTE =
	"Scripts are not interpolated: these characters reach the script verbatim. " +
	'Read the variable with pm.environment.get("name").';

export interface VariableReference {
	name: string;
	via: ReferenceSyntax;
}

/**
 * Names, deduplicated, each with the syntax that earns it the stronger claim.
 *
 * A name written both ways is `pm`: the script does read it, and the `{{}}`
 * beside the call is decoration. That asymmetry is the whole point of carrying
 * the syntax - the weaker claim must never overwrite the stronger one.
 *
 * Grouped by syntax rather than by position in the script - which is what the
 * two panels did, and is kept deliberately so this stays a refactor. It is
 * worth knowing rather than assuming: the panel chips the first five and
 * counts the rest, so adding a `pm.globals.get()` below an existing `{{name}}`
 * pushes that name down the list even though it comes first in the file.
 */
export function referencedVariables(script: string): VariableReference[] {
	const byName = new Map<string, ReferenceSyntax>();
	const add = (name: string, via: ReferenceSyntax) => {
		if (name.length === 0) return;
		// `pm` wins over `template`, and a repeat never downgrades what is there.
		if (via === "pm" || !byName.has(name)) byName.set(name, via);
	};

	for (const match of script.matchAll(PM_GET)) add(match[1], "pm");
	for (const match of script.matchAll(VARIABLE_PATTERN)) add(match[1].trim(), "template");

	return [...byName].map(([name, via]) => ({ name, via }));
}
