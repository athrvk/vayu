/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A row's focus indicator reaches WCAG 1.4.11's 3:1 against the surface it
 * sits on, in every accent scheme and both themes (#3499).
 *
 * `.focus-row` drew `--primary` at 30%, which composites to 1.42-2.00 on a
 * card; the two disclosure chevrons carried the same alpha as `ring-primary/30`.
 * The indicators are read out of the stylesheet and the two components rather
 * than restated, so an alpha put back, or a token swapped for one that does
 * not reach, changes the verdict. `--ring` is re-declared per scheme and per
 * theme, so the colour is resolved the way the cascade does
 * (`resolveToken`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexCss as css } from "@/lib/css-tokens.testkit";
import { THEMES, composite, contrastRatio, resolveToken } from "@/lib/contrast-math.testkit";
import { COLOR_SCHEMES } from "@/constants/color-schemes";

const src = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(src, rel), "utf8");

const SURFACES = ["card", "panel", "background"] as const;
const BAR = 3;

interface Indicator {
	name: string;
	token: string;
	alpha: number;
}

/** `.focus-row`'s outline colour: `hsl(var(--token))` or `hsl(var(--token) / a)`. */
function focusRowOutline(): Indicator {
	const rule = /:where\(\.focus-row\):focus-visible,[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
	const m = /outline:[^;]*hsl\(var\(--([a-z-]+)\)(?:\s*\/\s*([\d.]+))?\)/.exec(rule);
	if (!m) throw new Error("the .focus-row outline no longer names an hsl(var(--token))");
	return { name: ".focus-row outline", token: m[1], alpha: m[2] ? Number(m[2]) : 1 };
}

/** A chevron's `focus-visible:ring-<token>[/<alpha>]`; `ring-2` is the width. */
function chevronRing(name: string, file: string): Indicator {
	const m = /focus-visible:ring-(?!\d)([a-z-]+)(?:\/(\d+))?/.exec(read(file));
	if (!m) throw new Error(`${file} no longer has a focus-visible ring colour`);
	return { name, token: m[1], alpha: m[2] ? Number(m[2]) / 100 : 1 };
}

const INDICATORS: Indicator[] = [
	focusRowOutline(),
	chevronRing("ElementList chevron ring", "components/shared/ElementList/index.tsx"),
	chevronRing("CollectionItem chevron ring", "modules/collections/CollectionItem.tsx"),
];

const SCHEMES = COLOR_SCHEMES.map((s) => s.value);

describe("the scan itself", () => {
	it("read the stylesheet, every scheme, and three indicators", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(SCHEMES.length).toBeGreaterThan(5);
		expect(INDICATORS).toHaveLength(3);
		for (const i of INDICATORS) {
			expect(i.token.length, i.name).toBeGreaterThan(0);
			expect(i.alpha, i.name).toBeGreaterThan(0);
		}
	});
});

describe("a row's focus indicator, composited on the surface it sits on", () => {
	const cases = SCHEMES.flatMap((scheme) => THEMES.map((theme) => [scheme, theme] as const));

	it.each(cases)("%s %s reaches 3:1 on card, panel and canvas", (scheme, theme) => {
		for (const indicator of INDICATORS) {
			const colour = resolveToken(indicator.token, scheme, theme);
			for (const surface of SURFACES) {
				const bg = resolveToken(surface, scheme, theme);
				const ratio = contrastRatio(composite(colour, bg, indicator.alpha), bg);
				expect(
					ratio,
					`${indicator.name} on ${surface} (${scheme} ${theme}): ${ratio.toFixed(2)}`
				).toBeGreaterThanOrEqual(BAR);
			}
		}
	});
});
