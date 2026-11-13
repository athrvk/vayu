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
 * theme, so the colour is resolved the way the cascade does: the scheme block
 * first, the base `:root` / `.dark` block when the scheme leaves it alone.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexCss as css } from "@/lib/css-tokens.testkit";
import { COLOR_SCHEMES } from "@/constants/color-schemes";

const src = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(src, rel), "utf8");

type Theme = "light" | "dark";
type Rgb = [number, number, number];

const THEMES: Theme[] = ["light", "dark"];
const SURFACES = ["card", "panel", "background"] as const;
const BAR = 3;

/** Same anchoring as `color-schemes.test.ts`: `.dark[...]` contains `[...]`. */
function blockBody(selector: string): string {
	const escaped = selector.replace(/[.[\]"=-]/g, "\\$&");
	const m = new RegExp(`^\\t${escaped} \\{`, "m").exec(css);
	if (!m) throw new Error(`no block for ${selector}`);
	return css.slice(m.index, css.indexOf("\n\t}", m.index));
}

function hslOf(body: string, token: string): Rgb | undefined {
	const m = new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(body);
	if (!m) return undefined;
	const H = Number(m[1]) / 360,
		S = Number(m[2]) / 100,
		L = Number(m[3]) / 100;
	const f = (n: number) => {
		const k = (n + H * 12) % 12;
		const a = S * Math.min(L, 1 - L);
		return L - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
	};
	return [f(0), f(8), f(4)];
}

/** A token as the cascade resolves it for one scheme and theme. */
function resolve(token: string, scheme: string, theme: Theme): Rgb {
	const dark = theme === "dark";
	const own = blockBody(`${dark ? ".dark" : ""}[data-color-scheme="${scheme}"]`);
	const base = blockBody(dark ? ".dark" : ":root");
	const value = hslOf(own, token) ?? hslOf(base, token);
	if (!value) throw new Error(`--${token} not found for ${scheme} ${theme}`);
	return value;
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function contrast(a: Rgb, b: Rgb): number {
	const la = luminance(a),
		lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
	return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

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
			const colour = resolve(indicator.token, scheme, theme);
			for (const surface of SURFACES) {
				const bg = resolve(surface, scheme, theme);
				const ratio = contrast(over(colour, bg, indicator.alpha), bg);
				expect(
					ratio,
					`${indicator.name} on ${surface} (${scheme} ${theme}): ${ratio.toFixed(2)}`
				).toBeGreaterThanOrEqual(BAR);
			}
		}
	});
});
