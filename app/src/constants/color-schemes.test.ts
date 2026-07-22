/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every registered accent scheme must exist in the stylesheet, in both themes.
 *
 * The registry and the CSS are two files that have to agree, and disagreeing
 * fails *silently*: `data-color-scheme="magenta"` with no matching selector
 * simply inherits `:root`, so the picker offers a swatch that quietly does
 * nothing. Nothing in the type system connects the two.
 *
 * The dark block is checked separately from the light one because it is the
 * easier half to forget - and forgetting it is worse than forgetting both. A
 * scheme with only a light block looks correct until you switch theme, at which
 * point the accent silently reverts to the default while the setting still
 * reads as the chosen one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COLOR_SCHEMES, DEFAULT_COLOR_SCHEME, isColorScheme } from "./color-schemes";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"), "utf8");

// Every token a scheme block is expected to set. `--primary-fill` is the one
// that carries a white label, so it must be present even though it is the only
// token that deliberately does *not* change between themes.
const REQUIRED = [
	"--primary",
	"--primary-fill",
	"--primary-foreground",
	"--ring",
	"--variable",
	"--chart-1",
];

/**
 * Anchored at the start of the line, because `.dark[data-color-scheme="x"]`
 * *contains* `[data-color-scheme="x"]` as a substring - a plain `indexOf` for
 * the light selector happily returns the dark block and reports success for a
 * light block that does not exist. Mutation testing caught that; the deleted
 * light block passed.
 */
function block(selector: string, dark: boolean): string | null {
	const pattern = new RegExp(
		`^\\t${dark ? "\\.dark" : ""}\\[data-color-scheme="${selector}"\\] \\{`,
		"m"
	);
	const m = pattern.exec(css);
	if (!m) return null;
	const end = css.indexOf("\n\t}", m.index);
	return css.slice(m.index, end);
}

describe("accent colour schemes", () => {
	it("reads a stylesheet that is actually populated", () => {
		// vitest stubs CSS imports to "" - this file is read from disk for that
		// reason, and a guard that scans an empty string passes for free.
		expect(css.length).toBeGreaterThan(1000);
		expect(css).toContain("data-color-scheme");
	});

	it.each(COLOR_SCHEMES.map((s) => s.value))("%s has a light block with every token", (value) => {
		const b = block(value, false);
		expect(b, `no light block for "${value}"`).not.toBeNull();
		for (const token of REQUIRED) expect(b).toContain(`${token}:`);
	});

	it.each(COLOR_SCHEMES.map((s) => s.value))("%s has a dark block with every token", (value) => {
		const b = block(value, true);
		expect(b, `no dark block for "${value}"`).not.toBeNull();
		for (const token of REQUIRED) expect(b).toContain(`${token}:`);
	});

	it("keeps --primary-fill pinned across themes, and lets --primary diverge", () => {
		// This split is the whole reason white labels stay legible: the fill is
		// one value in both themes, while --primary brightens in dark because it
		// is text, ring and chart-series colour on a near-black card.
		for (const { value } of COLOR_SCHEMES) {
			const light = block(value, false) ?? "";
			const dark = block(value, true) ?? "";
			const fill = (b: string) => /--primary-fill:\s*([^;]+);/.exec(b)?.[1].trim();
			expect(fill(dark), `${value}: --primary-fill must not change between themes`).toBe(
				fill(light)
			);
		}
	});

	it("has no orphan CSS blocks for schemes the registry does not offer", () => {
		// Widened deliberately: COLOR_SCHEMES is `as const`, so the inferred Set is
		// of the literal union and will not accept an arbitrary string scraped out
		// of the stylesheet - which is exactly what this test needs to check.
		const declared = new Set<string>(COLOR_SCHEMES.map((s) => s.value));
		const found = [...css.matchAll(/\[data-color-scheme="([A-Za-z-]+)"\]/g)].map((m) => m[1]);
		expect([...new Set(found)].filter((v) => !declared.has(v))).toEqual([]);
	});

	it("recognises the new schemes and still defaults to a real one", () => {
		expect(isColorScheme("magenta")).toBe(true);
		expect(isColorScheme("graphite")).toBe(true);
		expect(isColorScheme("chartreuse")).toBe(false);
		expect(COLOR_SCHEMES.some((s) => s.value === DEFAULT_COLOR_SCHEME)).toBe(true);
	});
});
