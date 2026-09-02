/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What `index.css` declares, for the guards that check the stylesheet against
 * something else.
 *
 * Two guards now ask the same question of the same file - `design-system-doc`
 * asks "does the doc quote a value this stylesheet declares", and
 * `status-color-tokens` asks "which families declare a `-text` foreground" -
 * and both answers come out of one parse. The parse lives here rather than in
 * either guard because a second copy of it would not receive the first one's
 * fixes: the value regex already had to learn that the doc aligns values in
 * columns, and a copy written today would start without that.
 *
 * `status-color-tokens` used to answer its half by hand, listing the seven
 * families someone had noticed. The stylesheet had since grown three more
 * (`status-redirect`, `status-no-response`, `status-warning`), so three
 * families with a real `-text` pair were guarded by nothing - #1253.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The stylesheet, read off disk rather than imported. vitest stubs a CSS import
 * to `""`, and a guard that scans an empty string passes for free.
 */
export const indexCss: string = readFileSync(join(here, "..", "index.css"), "utf8");

/** Every declared value for a token, anywhere in the stylesheet. */
export function declaredValues(css: string = indexCss): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
		const value = m[2].split(/\s+/).join(" ").trim();
		if (!out.has(m[1])) out.set(m[1], new Set());
		out.get(m[1])!.add(value);
	}
	return out;
}

/** An HSL triple the palette states outright, rather than aliasing with `var()`. */
const OWN_COLOUR = /^[\d.]+ [\d.]+% [\d.]+%$/;

/**
 * The base `:root` palette - the vocabulary the `.dark` block and every accent
 * scheme re-tune, and the only block where a token's own definition lives.
 *
 * Tokens that alias another (`--primary-text: var(--primary)`) are left out:
 * the value they hold is the one they point at, so they declare no colour of
 * their own. Anything a scheme block overrides is left out too, by only reading
 * this block - `--primary-text` is a literal in the graphite scheme and an alias
 * here, and it is the base palette that says what the token is *for*.
 */
export function basePalette(css: string = indexCss): Map<string, string> {
	const block = /^\t:root \{([\s\S]*?)\n\t\}/m.exec(css)?.[1] ?? "";
	const out = new Map<string, string>();
	for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
		const value = m[2].split(/\s+/).join(" ").trim();
		if (OWN_COLOUR.test(value)) out.set(m[1], value);
	}
	return out;
}

/**
 * The colour families that ship a bare token and a `-text` foreground of its
 * own. Which families those are is the stylesheet's answer, not a list kept
 * here - writing one out is what this function exists to stop.
 *
 * A family qualifies by declaring both halves as colours in the base palette.
 * `primary` therefore does not: `--primary-text` aliases `--primary`, so there
 * is no second, more readable colour to prefer and nothing to ban. Should it
 * ever be given a colour of its own, it becomes the same case as the rest and
 * joins the list here rather than waiting to be noticed.
 */
export function familiesWithTextPair(css: string = indexCss): string[] {
	const palette = basePalette(css);
	return [...palette.keys()]
		.filter((name) => !name.endsWith("-text") && palette.has(`${name}-text`))
		.sort();
}
