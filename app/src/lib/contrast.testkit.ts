/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * WCAG contrast arithmetic for the guards that measure `index.css` tokens.
 *
 * Three guards (`status-token-contrast`, `checked-control-contrast`,
 * `tooltip-hint-contrast`) each carried a private copy of this, and a fourth
 * would have been the next one to miss a fix. Colours are the stylesheet's own
 * shape: an HSL triple in degrees and percents, as `--token: 38 92% 33%` states
 * it, converted to unit-range sRGB for the ratio.
 */

/** Hue in degrees, saturation and lightness in percent - a token's declared triple. */
export type Hsl = [number, number, number];

/** Unit-range sRGB channels. */
export type Rgb = [number, number, number];

export function toRgb([h, s, l]: Hsl): Rgb {
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

/** sRGB channel to linear light. */
export const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance([r, g, b]: Rgb): number {
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
	const la = luminance(a),
		lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a colour at `alpha` over a background - what a `/10` or `/80` resolves to. */
export function over(fg: Hsl, bg: Hsl, alpha: number): Rgb {
	const f = toRgb(fg),
		b = toRgb(bg);
	return [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as Rgb;
}
