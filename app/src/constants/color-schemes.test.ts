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
import { indexCss as css } from "@/lib/css-tokens.testkit";
import { COLOR_SCHEMES, DEFAULT_COLOR_SCHEME, isColorScheme } from "./color-schemes";

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
		// vitest stubs CSS imports to "" - the testkit reads the stylesheet off
		// disk for that reason, and a guard that scans an empty string passes for
		// free. The floor stays here: the import says where the text came from,
		// this says the scan found something.
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

	it("makes a desaturated scheme declare its own --primary-text", () => {
		/*
		 * `--primary-text` is the accent when the accent *is* the label, and it
		 * defaults to `--primary` - correct for seven of the eight schemes,
		 * because what separates an active tab from an inactive one is almost
		 * entirely saturation, not lightness. Measured on `--card`, accent text
		 * and `--muted-foreground` sit within a 1.01-1.56 contrast ratio in every
		 * scheme; the eye reads "coloured vs grey", and 55-95% saturation against
		 * an inactive 4-5% carries it.
		 *
		 * Graphite is S=12%/15% - it is the only desaturated scheme, which
		 * `docs/design-system.md` notes as what makes it distinct in the picker.
		 * It therefore has neither a lightness gap nor a saturation gap, and must
		 * separate by lightness instead.
		 *
		 * The rule is derived from the saturation rather than hardcoded to
		 * "graphite", so the next desaturated scheme cannot ship the same bug.
		 * `--primary-text` is deliberately NOT in REQUIRED: inheriting it is the
		 * correct behaviour for a saturated scheme, not a forgotten block.
		 */
		const saturation = (b: string) =>
			Number(/--primary:\s*[\d.]+\s+([\d.]+)%/.exec(b)?.[1] ?? NaN);

		let checked = 0;
		for (const { value } of COLOR_SCHEMES) {
			for (const dark of [false, true]) {
				const b = block(value, dark) ?? "";
				const s = saturation(b);
				expect(
					s,
					`${value} (${dark ? "dark" : "light"}): no --primary to read`
				).not.toBeNaN();
				if (s >= 25) continue;
				checked++;
				expect(
					b,
					`"${value}" has --primary at ${s}% saturation, too little to separate an ` +
						`active label from --muted-foreground by hue. It must declare its own ` +
						`--primary-text (${dark ? "dark" : "light"} block).`
				).toContain("--primary-text:");
			}
		}
		// Guards the guard: if no scheme is desaturated, the loop above asserts
		// nothing and passes for free.
		expect(checked).toBeGreaterThan(0);
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
