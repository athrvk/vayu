/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Blank out comment bodies, keeping newlines so line numbers still line up.
 *
 * A source-scanning guard that matches on a raw class string trips on its
 * own commentary: a comment recording what a class used to be (`h-5`,
 * `size-7`, `w-3 h-3`), or explaining what it is now, contains the same
 * substring the guard is looking for in the code. Strip comments first, or
 * a guard can pass on the strength of prose alone - in either direction,
 * confirmed live for `chrome-floors.test.ts` (a fix reverted in code stayed
 * "found" because the explanatory comment beside it still named the class).
 *
 * Matches `/* ... *\/` across the whole source rather than per line, on
 * purpose: a per-line, leading-asterisk-only version misses a JSX
 * brace-wrapped block comment (`{/* ... *\/}`), which is neither a `//` line
 * nor a leading-asterisk block line - `palette-tokens.test.ts` flagged its
 * own documentation before this was fixed.
 */
export function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}
