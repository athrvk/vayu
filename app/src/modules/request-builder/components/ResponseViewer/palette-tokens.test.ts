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
 * near-black one, so when it fails in light mode - which is where every one of
 * these failed - there is no way to fix it without breaking the other theme.
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
 * **Scope is now the whole of `modules/` and `components/`** (issue #1693).
 * It used to be these two trees alone, because elsewhere the raw palette came
 * in explicit `light dark:` pairs - theme-aware, so not the contrast defect
 * above - and converting them needed tokens that did not exist. They do now:
 * the settings restart banner, the last `dark:`-paired holdout, sits on the
 * `--warning` family that the "Pending" chip one card below it already used,
 * which is the whole argument for widening. Two files carry a `dark:` pair
 * and two carry none; both kinds are named in EXCLUDED below, with the reason.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { globSync } from "node:fs";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..", "..", "..");

const GUARDED = ["modules/**/*.tsx", "components/**/*.tsx"];

/**
 * Two files, one colour, one reason.
 *
 * `text-purple-500` marks a *load test* - the sidebar row's bolt and the P99
 * tile's trend arrow. It is a kind, not a status, so the one violet token the
 * app has (`--status-redirect`, which means 3xx) would be the wrong word for
 * it, and inventing a token for two icons is not worth a permanent entry in
 * the theme. Both were measured where they sit rather than assumed: 4.36
 * light / 4.59 dark on the sidebar row, 3.50 / 3.66 on the tile, against the
 * 3.0 icon bar in both themes - which is why neither needs a `dark:` pair.
 * The two call-site comments carry those numbers; this list only records that
 * the exemption is deliberate.
 *
 * If something needs adding here, say why in the same breath.
 */
const EXCLUDED: string[] = [
	"modules/history/sidebar/RunItem.tsx",
	"modules/history/main/LoadTestDetail.tsx",
];

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

// `text-green-500`, `bg-blue-500/20`, `dark:border-amber-200` - any utility
// prefix, any modifier chain, optional opacity suffix.
const RAW = new RegExp(
	String.raw`\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-(?:${PALETTE.join("|")})-\d{2,3}\b`,
	"g"
);

function guardedFiles(): string[] {
	const excluded = new Set(EXCLUDED.map((f) => f.split("/").join(sep)));
	return (
		GUARDED.flatMap((pattern) => globSync(pattern, { cwd: srcRoot }))
			// A test asserting on a class it expects to find is not a call site.
			.filter((f) => !/\.test\.tsx$/.test(f))
			.filter((f) => !excluded.has(f))
			.map((f) => join(srcRoot, f))
	);
}

describe("modules and components use design tokens, not raw palette colours", () => {
	it("scans a non-empty set of files", () => {
		// The radius guard once passed for weeks while scanning an empty string.
		// A guard that cannot fail is worse than no guard, because it reads as
		// coverage.
		expect(guardedFiles().length).toBeGreaterThan(200);
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
