/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A tooltip's secondary line has to read on the tooltip.
 *
 * `TooltipContent` paints `bg-primary-fill`, so a hint's colour sits on a
 * saturated accent, not on the canvas - and `--muted-foreground` is tuned for
 * the canvas. On the fills it measures **1.04 to 2.27:1**, which is not a
 * de-emphasis but a disappearance: `TooltipIconButton` rendered its hint that
 * way and the mock-server row's tooltip printed `http://127.0.0.1:51056` in
 * grey-on-blue at 1.04, the URL being the one thing in that tooltip a reader
 * has to read.
 *
 * The bar is 2.5:1 in every accent scheme and both themes. That is below the
 * label's own white, which bottoms out at 3.6:1 on `sunset` and is the fill's
 * own ceiling - a hint cannot beat the text it is secondary to - and far above
 * the canvas token, which fails the bar on every scheme. Both halves are
 * asserted: a test that only checks the new value passes just as happily on a
 * bar so low the old one would have cleared it.
 *
 * Values are parsed out of `index.css` rather than restated, so a retuned
 * accent is measured rather than assumed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = dirname(fileURLToPath(import.meta.url));
const SRC = join(uiDir, "..", "..");
const css = readFileSync(join(SRC, "index.css"), "utf8");
const tooltip = readFileSync(join(uiDir, "tooltip.tsx"), "utf8");

type Hsl = [number, number, number];

function declarations(name: string): Hsl[] {
	const re = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`, "g");
	return [...css.matchAll(re)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
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

function luminance([r, g, b]: [number, number, number]): number {
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const la = luminance(a),
		lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a colour at `alpha` over a background - what `/80` resolves to. */
function over(fg: Hsl, bg: Hsl, alpha: number): [number, number, number] {
	const f = toRgb(fg),
		b = toRgb(bg);
	return [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as [number, number, number];
}

/** Every `--primary-fill` in the stylesheet: the default plus each accent. */
const FILLS = declarations("primary-fill");
const FOREGROUNDS = declarations("primary-foreground");
const MUTED = declarations("muted-foreground");

/** The hint's own alpha, read off the component so the two cannot drift. */
const alpha = (() => {
	const m = tooltip.match(/text-primary-foreground\/(\d+)/);
	if (!m) throw new Error("TooltipHint no longer tints --primary-foreground");
	return Number(m[1]) / 100;
})();

const BAR = 2.5;

describe("the scan itself", () => {
	it("found the fills, the foregrounds and the hint's alpha", () => {
		// A stylesheet that stopped matching would make every case below vacuous.
		expect(FILLS.length).toBeGreaterThan(5);
		expect(FOREGROUNDS.length).toBeGreaterThan(0);
		expect(MUTED.length).toBeGreaterThan(0);
		expect(alpha).toBeGreaterThan(0);
	});
});

describe("a tooltip hint on the tooltip's own fill", () => {
	it.each(FILLS.map((fill) => [fill.join(" "), fill] as const))("clears %s", (_label, fill) => {
		for (const fg of FOREGROUNDS) {
			expect(contrast(over(fg, fill, alpha), toRgb(fill))).toBeGreaterThanOrEqual(BAR);
		}
	});

	/*
	 * The half that makes the bar mean something. `--muted-foreground` is the
	 * colour the hint used to carry, and it fails on every fill - so the bar is
	 * one the old value could not have passed, and reverting the component to it
	 * fails the suite rather than sliding under a lenient threshold.
	 */
	it.each(FILLS.map((fill) => [fill.join(" "), fill] as const))(
		"is a bar the canvas-tuned --muted-foreground fails on %s",
		(_label, fill) => {
			for (const muted of MUTED) {
				expect(contrast(toRgb(muted), toRgb(fill))).toBeLessThan(BAR);
			}
		}
	);
});

/*
 * Fixing three call sites does not fix the app: the next hand-written tooltip
 * can reach for `text-muted-foreground` exactly as this one did, and every
 * assertion above would stay green. So the rule is made **enumerable rather
 * than impossible**, the way the border rules are - the mistake is one shape,
 * a canvas-tuned foreground inside a `TooltipContent`, and every block in the
 * app is read.
 *
 * A scan cannot see a class that arrives in a variable, which is why the
 * rendered-class guard in `tooltip-icon-button.test.tsx` exists alongside it.
 * The two catch different halves and neither is sufficient.
 */
function tsxFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsxFiles(full));
		else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
	}
	return out;
}

/** `<TooltipContent …>…</TooltipContent>`, comments stripped so prose about the
 *  rule does not read as a violation of it. */
const TOOLTIP_BLOCK = /<TooltipContent\b[^>]*>[\s\S]*?<\/TooltipContent>/g;

/** The foregrounds tuned for the canvas: muted, plain, and the `-text` tier. */
const CANVAS_FOREGROUND = /\btext-(?:muted-foreground|foreground|[a-z]+-text)\b/;

const blocks = tsxFiles(SRC).flatMap((file) =>
	[
		...readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(TOOLTIP_BLOCK),
	].map((m) => ({ file, source: m[0] }))
);

describe("every tooltip in the app, not only the three this fix touched", () => {
	it("found the tooltips to scan", () => {
		// A regex that stopped matching would make the next case vacuous - this
		// repo has had a guard pass for weeks while reading an empty string.
		expect(blocks.length).toBeGreaterThan(12);
	});

	it("paints no canvas-tuned foreground on the tooltip's fill", () => {
		const offenders = blocks
			.filter((b) => CANVAS_FOREGROUND.test(b.source))
			.map((b) => `${b.file}: ${CANVAS_FOREGROUND.exec(b.source)?.[0]}`);
		expect(offenders).toEqual([]);
	});
});
