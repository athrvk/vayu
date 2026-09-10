/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Returns the CSS variable reference for an HTTP method's color token.
 * Use as: `hsl(${getMethodColor(method)})` for a solid color,
 *      or `hsl(${getMethodColor(method)} / 0.1)` for a tinted background.
 */
export function getMethodColor(method: string): string {
	const m = method.toLowerCase();
	const known = ["get", "post", "put", "patch", "delete", "head", "options"];
	return known.includes(m) ? `var(--method-${m})` : "var(--method-options)";
}

/**
 * Standard HTTP methods whose full name is longer than the five-character
 * fixed column `MethodBadge` uses, and the label the badge renders in their
 * place. The abbreviations are the ones every other client picks - `DEL` for
 * `DELETE`, `OPT` for `OPTIONS`, `CONN` for `CONNECT` - and the badge exposes
 * the full method as `title` when it substitutes one, so the meaning is one
 * hover away. Kept beside `getMethodColor` for the same reason: one value,
 * one meaning everywhere.
 */
export const METHOD_ABBREVIATIONS: Readonly<Record<string, string>> = {
	DELETE: "DEL",
	OPTIONS: "OPT",
	CONNECT: "CONN",
};

/**
 * Returns the label to display for a method and whether it was substituted
 * for the full name. `abbreviated: true` means the caller should reveal the
 * full method on hover (as `MethodBadge` does through its `title`) - a `DEL`
 * on screen without that would leave a user guessing between `DELETE` and
 * `DEL` the same way an unlabelled icon does.
 */
export function getMethodDisplayLabel(method: string): {
	label: string;
	abbreviated: boolean;
} {
	const upper = method.toUpperCase();
	const abbrev = METHOD_ABBREVIATIONS[upper];
	return abbrev ? { label: abbrev, abbreviated: true } : { label: upper, abbreviated: false };
}
