/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every accent scheme reads at 4.5:1 in both themes (#3499).
 *
 * Two jobs, two tokens. `--primary` is accent text (`text-primary`) and has to
 * clear 4.5 on every surface it can sit on; in light the darkest of them,
 * `--muted` / `--accent` at 93%, is what sets it. `--primary-fill` is a solid
 * under a white label (`--primary-foreground`) and has to clear 4.5 under it.
 * `--primary-text`, the accent as a tab label, is held to the same bar: it
 * aliases `--primary` in most schemes and is a literal in the rest.
 *
 * Values come out of `index.css` through the cascade the browser applies, so a
 * retuned scheme is measured rather than assumed. The unattributed default
 * (`:root` / `.dark` alone) is measured too: it is what paints before the
 * scheme attribute lands.
 */

import { describe, it, expect } from "vitest";
import { indexCss as css } from "@/lib/css-tokens.testkit";
import { THEMES, contrastRatio, resolveToken } from "@/lib/contrast-math.testkit";
import { COLOR_SCHEMES } from "./color-schemes";

const BAR = 4.5;
const SURFACES = ["card", "panel", "background", "muted", "accent"] as const;
const TEXT_TOKENS = ["primary", "primary-text"] as const;

const SCHEMES: (string | null)[] = [...COLOR_SCHEMES.map((s) => s.value), null];
const CASES = SCHEMES.flatMap((scheme) =>
	THEMES.map((theme) => [scheme ?? "default", theme, scheme] as const)
);

describe("the scan itself", () => {
	it("read the stylesheet and every scheme in both themes", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(COLOR_SCHEMES.length).toBeGreaterThan(5);
		expect(CASES.length).toBe(SCHEMES.length * 2);
	});
});

describe("accent text on every surface", () => {
	it.each(CASES)("%s %s clears 4.5:1", (_label, theme, scheme) => {
		const misses: string[] = [];
		for (const token of TEXT_TOKENS) {
			const text = resolveToken(token, scheme, theme);
			for (const surface of SURFACES) {
				const ratio = contrastRatio(text, resolveToken(surface, scheme, theme));
				if (ratio < BAR) misses.push(`--${token} on --${surface}: ${ratio.toFixed(2)}`);
			}
		}
		expect(misses).toEqual([]);
	});
});

describe("the white label on the fill", () => {
	it.each(CASES)("%s %s clears 4.5:1", (_label, theme, scheme) => {
		const label = resolveToken("primary-foreground", scheme, theme);
		const fill = resolveToken("primary-fill", scheme, theme);
		expect(contrastRatio(label, fill)).toBeGreaterThanOrEqual(BAR);
	});
});
