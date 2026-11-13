/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * WCAG contrast, OKLab distance and the accent-scheme cascade, for the guards
 * that measure `index.css` rather than restate it.
 *
 * Four guards carried their own copy of the sRGB-to-luminance chain before this
 * file existed (#3499). The colour maths is the part a copy gets subtly wrong
 * and never hears about, so it lives here once.
 */

import { indexCss } from "./css-tokens.testkit";

/** An `index.css` colour as declared: hue in degrees, saturation and lightness in percent. */
export type Hsl = readonly [number, number, number];
/** sRGB, each channel in 0..1. */
export type Rgb = readonly [number, number, number];
export type Theme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark"];
export const WHITE: Rgb = [1, 1, 1];

export function hslToRgb([h, s, l]: Hsl): Rgb {
	const H = h / 360,
		S = s / 100,
		L = l / 100;
	const f = (n: number) => {
		const k = (n + H * 12) % 12;
		const a = S * Math.min(L, 1 - L);
		return L - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
	};
	return [f(0), f(8), f(4)];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance([r, g, b]: Rgb): number {
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, 1 to 21; order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a),
		lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` over `bg` - what a `/30` or `hsl(... / 0.3)` resolves to on screen. */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
	const mix = (i: 0 | 1 | 2) => fg[i] * alpha + bg[i] * (1 - alpha);
	return [mix(0), mix(1), mix(2)];
}

function oklab(rgb: Rgb): readonly [number, number, number] {
	const [r, g, b] = rgb.map(linear);
	const L = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const M = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const S = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * L + 0.793617785 * M - 0.0040720468 * S,
		1.9779984951 * L - 2.428592205 * M + 0.4505937099 * S,
		0.0259040371 * L + 0.7827717662 * M - 0.808675766 * S,
	];
}

/**
 * OKLab distance, the measure the accent schemes were placed by. Under about
 * 0.10 two colours read as the same one.
 */
export function oklabDistance(a: Rgb, b: Rgb): number {
	const p = oklab(a),
		q = oklab(b);
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** A token's own HSL triple in one block body, or `undefined` when it aliases or is absent. */
export function declaredHsl(body: string, token: string): Hsl | undefined {
	const m = new RegExp(`(?<![\\w-])--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(
		body
	);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * A top-level block's body by its exact selector, comments blanked.
 *
 * Anchored at a line start: `.dark[data-color-scheme="x"]` contains
 * `[data-color-scheme="x"]`, so an unanchored search finds the dark block when
 * asked for the light one.
 */
export function blockBody(selector: string, css: string = indexCss): string {
	const escaped = selector.replace(/[.[\]"=:-]/g, "\\$&");
	const m = new RegExp(`^\\t${escaped} \\{`, "m").exec(css);
	if (!m) throw new Error(`index.css has no block for ${selector}`);
	return css
		.slice(m.index, css.indexOf("\n\t}", m.index))
		.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/**
 * The blocks that can set a token for a scheme and theme, the winner first.
 *
 * `<html>` carries `.dark` and `data-color-scheme` together, so in dark four
 * blocks apply. The dark scheme block outranks the rest by specificity; the
 * other three tie, and source order (`:root`, the light scheme blocks, `.dark`)
 * decides. A token a light scheme block sets therefore reaches dark unless
 * `.dark` or the dark scheme block sets it again. `scheme` null is the
 * unattributed default, the `:root` / `.dark` pair alone.
 */
function cascade(scheme: string | null, theme: Theme, css: string): string[] {
	const light = scheme ? [blockBody(`[data-color-scheme="${scheme}"]`, css)] : [];
	const root = blockBody(":root", css);
	if (theme === "light") return [...light, root];
	const dark = scheme ? [blockBody(`.dark[data-color-scheme="${scheme}"]`, css)] : [];
	return [...dark, blockBody(".dark", css), ...light, root];
}

/**
 * A token as the cascade resolves it, following a `var(--other)` alias the way
 * the browser does: against the same element, so the alias picks up the
 * scheme's own value for `--other`.
 */
export function resolveToken(
	token: string,
	scheme: string | null,
	theme: Theme,
	css: string = indexCss
): Rgb {
	for (const body of cascade(scheme, theme, css)) {
		const value = new RegExp(`(?<![\\w-])--${token}:\\s*([^;]+);`).exec(body)?.[1].trim();
		if (value === undefined) continue;
		const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
		if (alias) return resolveToken(alias[1], scheme, theme, css);
		const hsl = declaredHsl(`--${token}: ${value};`, token);
		if (!hsl) throw new Error(`--${token} is "${value}", not an HSL triple or an alias`);
		return hslToRgb(hsl);
	}
	throw new Error(`--${token} is not declared for ${scheme ?? "the default"} ${theme}`);
}
