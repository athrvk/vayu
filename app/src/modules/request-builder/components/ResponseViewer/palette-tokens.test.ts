/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Raw Tailwind palette colours are banned in the request/response tree.
 *
 * They are theme-blind: `text-green-500` is one value on a white card and on a
 * near-black one, so when it fails in light mode — which is where every one of
 * these failed — there is no way to fix it without breaking the other theme.
 * Measured before conversion, against `bg-card` unless noted:
 *
 *     usage                                   light   dark   need
 *     UrlBar "View running test" label         1.95   7.40    4.5
 *     ConsoleOutput headings (green)           2.22   7.78    4.5
 *     ConsoleOutput headings (blue)            3.76   4.60    4.5
 *     ConsoleOutput Terminal icon /70 on muted 1.63   4.01    3.0
 *     HeadersViewer header names (green)       2.22   7.78    4.5
 *     Copy-confirmation check                  2.22   7.78    3.0
 *     Live-run dot                             2.30   7.53    3.0
 *
 * and after, on the per-theme `-text` tokens: 4.98/8.36, 5.68/8.80, 5.98/6.76,
 * 4.83/7.66, 5.68/8.80, 5.68/8.80, and 4.84/3.57 for the dot on the fill token.
 *
 * **Scope is deliberate.** This guards the trees that were measured, not the
 * whole app. Elsewhere — the history tabs, the settings banners — the raw
 * palette classes come in explicit `light dark:` pairs, which are theme-aware
 * and therefore not this defect; converting those is a design decision about
 * introducing new tokens (there is no purple or info `-text` token today), not
 * a contrast fix. Widen this guard when those tokens exist, not before.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { globSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..", "..", "..");

const GUARDED = ["modules/request-builder/**/*.tsx", "components/shared/response-viewer/**/*.tsx"];

/**
 * Excluded, named rather than quietly filtered by pattern.
 *
 * LoadTestConfigDialog's palette classes are the bucket this change decided not
 * to touch: an info callout written as an explicit `bg-blue-50 … dark:bg-blue-950`
 * pair, which is theme-aware and so is not the defect above, and a
 * `bg-purple-600` submit button for which no purple semantic token exists. Both
 * want a token that would have to be invented first. Converting them is a design
 * decision; remove this exclusion when that decision is made.
 */
const EXCLUDED = ["modules/request-builder/components/LoadTestConfigDialog.tsx"];

const PALETTE = [
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
	"slate",
	"gray",
	"zinc",
	"neutral",
	"stone",
];

// `text-green-500`, `bg-blue-500/20`, `dark:border-amber-200` — any utility
// prefix, any modifier chain, optional opacity suffix.
const RAW = new RegExp(
	String.raw`\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-(?:${PALETTE.join("|")})-\d{2,3}\b`,
	"g"
);

function guardedFiles(): string[] {
	const excluded = new Set(EXCLUDED.map((f) => f.split("/").join(sep)));
	return GUARDED.flatMap((pattern) => globSync(pattern, { cwd: srcRoot }))
		.filter((f) => !excluded.has(f))
		.map((f) => join(srcRoot, f));
}

/**
 * Blank out comment bodies, keeping newlines so line numbers still line up.
 *
 * These files quote the classes they replaced, to record what was measured, and
 * the first version of this guard flagged its own documentation — the JSX
 * JSX brace-wrapped block-comment form is neither a `//` line nor a
 * leading-asterisk block line, so per-line stripping missed it entirely.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("request/response tree uses design tokens, not raw palette colours", () => {
	it("scans a non-empty set of files", () => {
		// The radius guard once passed for weeks while scanning an empty string.
		// A guard that cannot fail is worse than no guard, because it reads as
		// coverage.
		expect(guardedFiles().length).toBeGreaterThan(15);
	});

	it("finds no raw palette colour classes", () => {
		const offences: string[] = [];

		for (const file of guardedFiles()) {
			const source = readFileSync(file, "utf8");
			const code = stripComments(source).split(/\r?\n/);
			source.split(/\r?\n/).forEach((line, i) => {
				const hits = code[i].match(RAW);
				if (hits) {
					offences.push(
						`${relative(srcRoot, file)}:${i + 1}  ${hits.join(", ")}\n    ${line.trim()}`
					);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});
