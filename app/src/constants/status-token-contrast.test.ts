/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The status tokens clear the bars they were chosen against.
 *
 * Three families were added or completed for the HTTP status vocabulary, and
 * each tier answers a different question, so each has its own bar:
 *
 *   indicator  a dot or icon on a card             >= 3.0, in *both* themes
 *   -text      the colour IS the text, on a tint   >= 4.5
 *   -fill      a solid chip under a white label    >= 4.5
 *
 * Values are parsed out of `index.css`, not restated here. A test that
 * hardcodes what it is checking passes when the stylesheet drifts away from it,
 * which is the failure mode `design-system-doc.test.ts` exists to catch.
 *
 * `--status-warning` is the interesting one. Amber cannot follow the `-500`
 * convention the other four indicators use: amber-500 (`38 92% 50%`) measures
 * 2.14 on a light card, well under the icon bar, which is why the family only
 * ever had a `-fill`. It sits far darker, close to its own fill. Brightening it
 * back toward amber-500 is the most likely future mistake, so it is asserted.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_TOKEN } from "@/modules/dashboard/components/charts/uplot/uplotTheme";

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.css");
const css = readFileSync(cssPath, "utf8");

/** Split `:root` from `.dark`, so a token defined in both resolves per theme. */
const darkStart = css.indexOf(".dark {");
const lightBlock = css.slice(0, darkStart);
const darkBlock = css.slice(darkStart);

type Hsl = [number, number, number];

function token(name: string, theme: "light" | "dark"): Hsl {
	const block = theme === "dark" ? darkBlock : lightBlock;
	const re = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`, "g");
	const all = [...block.matchAll(re)];
	// Dark only overrides the -text tier; indicators and fills are declared once
	// in :root and are mode-consistent by design.
	const m = all.length ? all[all.length - 1] : [...lightBlock.matchAll(re)].pop();
	if (!m) throw new Error(`--${name} not found for ${theme}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toRgb([h, s, l]: Hsl): [number, number, number] {
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

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map(lin);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Hsl | [number, number, number], b: Hsl, aIsRgb = false): number {
	const la = luminance(aIsRgb ? (a as [number, number, number]) : toRgb(a as Hsl));
	const lb = luminance(toRgb(b));
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a colour at `alpha` over a background - the `/10` tint surfaces. */
function over(fg: Hsl, bg: Hsl, alpha: number): [number, number, number] {
	const f = toRgb(fg),
		b = toRgb(bg);
	return [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as [number, number, number];
}

const CARD = { light: token("card", "light"), dark: token("card", "dark") } as const;

const NEW_FAMILIES = ["status-redirect", "status-no-response", "status-warning"] as const;

describe("the stylesheet was actually read", () => {
	it("is not the empty string vitest hands back for a CSS import", () => {
		// A source-scanning guard passed for weeks on this branch reading "".
		expect(css.length).toBeGreaterThan(1000);
		expect(css).toContain("--status-redirect:");
	});
});

describe("indicator tier clears 3.0 on a card, in both themes", () => {
	it.each(NEW_FAMILIES)("%s", (family) => {
		const value = token(family, "light");
		for (const theme of ["light", "dark"] as const) {
			expect(
				contrast(value, CARD[theme]),
				`${family} on ${theme} card`
			).toBeGreaterThanOrEqual(3.0);
		}
	});

	it("keeps amber dark enough to survive a light card", () => {
		// amber-500 measures 2.14 here. If this ever reads ~50% again, the
		// indicator has been "fixed" to match --warning and is under the bar.
		const [, , l] = token("status-warning", "light");
		expect(l).toBeLessThan(45);
	});
});

describe("-text tier clears 4.5 on its own 10% tint", () => {
	it.each(NEW_FAMILIES)("%s", (family) => {
		const indicator = token(family, "light");
		for (const theme of ["light", "dark"] as const) {
			const text = token(`${family}-text`, theme);
			const tint = over(indicator, CARD[theme], 0.1);
			expect(contrast(tint, text, true), `${family}-text on ${theme}`).toBeGreaterThanOrEqual(
				4.5
			);
		}
	});
});

describe("-fill tier carries a white label at 4.5", () => {
	it.each(["status-redirect", "status-no-response"] as const)("%s", (family) => {
		const white: Hsl = [0, 0, 100];
		expect(contrast(white, token(`${family}-fill`, "light"))).toBeGreaterThanOrEqual(4.5);
	});
});

/**
 * Tokens a chart series paints that do not clear 3.0, with their measured
 * values. Recorded rather than excluded silently, and asserted below so the gap
 * cannot widen unnoticed - the same treatment `--input` got when it could not
 * reach 3.0 without turning every field into a hard outline.
 */
const KNOWN_GAPS: Array<[string, "light" | "dark", number]> = [["status-success", "light", 2.3]];
const KNOWN_GAP_NAMES = new Set(KNOWN_GAPS.map(([n]) => n));

describe("every token a chart series paints clears 3.0 on its own plot", () => {
	/**
	 * The plot sits on `--card`, so a series colour has the same job as an icon:
	 * be distinguishable from the surface behind it.
	 *
	 * `--info` failed this. It was `199 89% 48%` in *both* themes - the only
	 * theme-blind entry in `ROLE_TOKEN` - and measured **2.85** on a light card
	 * while painting three series (wire, send rate, connections). Mode-consistency
	 * is deliberate for `--status-*` indicators, where one value must read as the
	 * same signal on either surface; `--info` had no such reason and had simply
	 * never been measured.
	 */
	/*
	 * Derived from `ROLE_TOKEN`, not listed by hand.
	 *
	 * A hardcoded list was written first and was decorative: pointing the chart
	 * roles back at `--warning` and `--destructive` left it green, because it
	 * went on checking `--series-warning`, which still existed and still passed.
	 * It asserted that some tokens are legible, not that the ones the charts
	 * actually paint are. Reading the map means repointing a role is what the
	 * test sees.
	 */
	const SERIES_TOKENS = [...new Set(Object.values(ROLE_TOKEN))].map((v) => v.replace(/^--/, ""));

	it("covers every role the chart theme can resolve", () => {
		expect(SERIES_TOKENS.length).toBeGreaterThanOrEqual(10);
	});

	it.each(SERIES_TOKENS.filter((n) => !KNOWN_GAP_NAMES.has(n)))("%s", (name) => {
		for (const theme of ["light", "dark"] as const) {
			expect(
				contrast(token(name, theme), CARD[theme]),
				`--${name} on ${theme}`
			).toBeGreaterThanOrEqual(3.0);
		}
	});

	/**
	 * One token paints a chart series and does not clear the bar. It is recorded
	 * with its measured value rather than excluded silently, and asserted so the
	 * gap cannot widen unnoticed - the same treatment `--input` got when it could
	 * not reach 3.0 without turning every field into a hard outline.
	 *
	 * `--status-success` is deliberate: `index.css` states the four original
	 * status indicators are mode-consistent so a green dot reads as "good" on
	 * either surface, trading the icon bar for that.
	 *
	 * `--warning` (2.14 light) and `--destructive` (1.73 dark) were here too, and
	 * were fixed rather than tolerated: charts now paint from a `--series-*`
	 * tier, so a token tuned to carry a white button label is no longer also
	 * asked to read as a line on a near-black plot.
	 */
	it.each(KNOWN_GAPS)("%s is a known gap on %s, still around %d", (name, theme, expected) => {
		const actual = contrast(token(name, theme), CARD[theme]);
		expect(actual).toBeCloseTo(expected, 1);
		// If one of these ever clears the bar, the gap is closed and the entry
		// should move up into SERIES_TOKENS rather than linger here.
		expect(actual, `--${name} now clears 3.0 - promote it`).toBeLessThan(3.0);
	});
});

describe("the five classes stay visually apart", () => {
	/**
	 * OKLab distance, the measure used to place the accent schemes. Under ~0.10
	 * two colours read as the same. The badge mapping this replaced scored
	 * 0.000 between a 5xx and a connection failure - literally the same token.
	 */
	function oklab([h, s, l]: Hsl): [number, number, number] {
		const [r, g, b] = toRgb([h, s, l]).map(lin);
		const L = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
		const M = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
		const S = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
		return [
			0.2104542553 * L + 0.793617785 * M - 0.0040720468 * S,
			1.9779984951 * L - 2.428592205 * M + 0.4505937099 * S,
			0.0259040371 * L + 0.7827717662 * M - 0.808675766 * S,
		];
	}
	const dE = (a: Hsl, b: Hsl) => {
		const [x1, y1, z1] = oklab(a);
		const [x2, y2, z2] = oklab(b);
		return Math.hypot(x1 - x2, y1 - y2, z1 - z2);
	};

	it("keeps every pair of indicators at least 0.10 apart", () => {
		const families = [
			"status-success",
			"status-redirect",
			"status-warning",
			"status-error",
			"status-no-response",
		];
		const values = families.map((f) => token(f, "light"));
		const pairs: string[] = [];

		for (let i = 0; i < values.length; i++) {
			for (let j = i + 1; j < values.length; j++) {
				const d = dE(values[i], values[j]);
				if (d < 0.1) pairs.push(`${families[i]} / ${families[j]} = ${d.toFixed(3)}`);
			}
		}

		expect(pairs.join("\n")).toBe("");
	});
});
