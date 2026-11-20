/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The user's font choices reach every `font-sans` / `font-mono` surface only
 * while the two stacks are plain `@theme` tokens (#3692).
 *
 * The stores write `--font-sans` and `--font-mono` onto `documentElement`.
 * Under `@theme inline` Tailwind bakes the declared stack into each utility
 * (`.font-mono { font-family: "JetBrains Mono", ... }`), so the override
 * reached Monaco and the few rules that spell `var(--font-mono)` by hand, and
 * no `font-mono` class at all. A plain `@theme` token compiles the utility to
 * `var(--font-mono)`, which the override does reach. Compiling the stylesheet
 * is too heavy for a unit test, so this holds the declaration's position.
 *
 * Read from disk rather than imported: vitest stubs a CSS import to `""`, and a
 * scan of an empty string passes forever (see the repo CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** The body of the first block opened by `header`, up to its closing brace. */
function blockBody(css: string, header: string): string {
	const start = css.indexOf(header);
	if (start < 0) return "";
	const open = css.indexOf("{", start);
	const close = css.indexOf("\n}", open);
	return css.slice(open + 1, close);
}

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const FONT_TOKENS = ["--font-sans", "--font-mono"] as const;

describe("the font stack tokens in index.css", () => {
	const inlineBlock = withoutComments(blockBody(indexCss, "@theme inline {"));
	const plainBlock = withoutComments(blockBody(indexCss, "\n@theme {"));

	it("scanned non-empty blocks", () => {
		// Without this the two scans below are vacuous.
		expect(indexCss.length).toBeGreaterThan(0);
		expect(inlineBlock).toContain("--color-background:");
		expect(plainBlock).toContain("--spacing-control:");
	});

	it.each(FONT_TOKENS)("declares %s outside the `@theme inline` block", (token) => {
		expect(inlineBlock).not.toContain(`${token}:`);
	});

	it.each(FONT_TOKENS)("declares %s in the plain `@theme` block", (token) => {
		expect(plainBlock).toContain(`${token}:`);
	});
});
