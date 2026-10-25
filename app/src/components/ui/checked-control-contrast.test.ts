/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A checked checkbox and an on switch carry a white mark on a solid fill.
 *
 * `--primary` brightens in dark so accent *text* reads on the near-black card
 * (issue #2305). Painted as a fill under a white check or thumb, that same
 * brightening drops the pair under WCAG 1.4.11's 3:1 on most schemes; the
 * fill token, `--primary-fill`, holds one deep value in both themes for
 * exactly this. The component source is read for the token it paints rather
 * than the test restating it, so the guard follows the class: put
 * `checked:bg-primary` back and the resolved name changes, and so does the
 * verdict.
 *
 * The track's edge is a second leg. `--primary-fill` is deep on purpose, so a
 * lone track can sit under 3:1 against `--card` (aurora measures 2.98); the
 * switch paints its reserved border with the brighter `--primary`, and that
 * edge is held against the card instead.
 *
 * Values are parsed out of `index.css`, so a retuned accent is measured rather
 * than assumed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(uiDir, "..", "..", "index.css"), "utf8");
const checkbox = readFileSync(join(uiDir, "checkbox.tsx"), "utf8");
const toggle = readFileSync(join(uiDir, "switch.tsx"), "utf8");

type Hsl = [number, number, number];
type Rgb = [number, number, number];

function toRgb([h, s, l]: Hsl): Rgb {
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

function luminance([r, g, b]: Rgb): number {
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
	const la = luminance(a),
		lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function declared(block: string, token: string): Hsl | undefined {
	const m = block.match(new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** The plain `.dark` default plus every `.dark[data-color-scheme="x"]` block. */
const DARK_SCHEMES = [...css.matchAll(/\.dark(?:\[data-color-scheme="([\w-]+)"\])?\s*\{([^}]*)\}/g)]
	.map(([, scheme, body]) => ({ scheme: scheme ?? "default", body }))
	.filter(({ body }) => declared(body, "primary-fill") && declared(body, "primary-foreground"));

/** Comments quote the classes they explain; only the code paints them. */
const withoutComments = (source: string) =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The colour token a component paints for its checked state, read off its source. */
function checkedFill(source: string, pattern: RegExp): string {
	const m = withoutComments(source).match(pattern);
	if (!m) throw new Error(`no checked-state background found by ${pattern}`);
	return m[1];
}

/** The colour token the switch paints on its checked border, read off its source. */
const switchCheckedEdge = () =>
	checkedFill(toggle, /"[^"]*data-\[state=checked\]:border-([a-z-]+)/);

/** A scheme's own value for a token, else the plain `.dark` default's (`--card` lives only there). */
function darkToken(body: string, token: string): Hsl | undefined {
	const fallback = DARK_SCHEMES.find((s) => s.scheme === "default")!.body;
	return declared(body, token) ?? declared(fallback, token);
}

const CONTROLS = [
	{
		name: "Checkbox",
		fill: () => checkedFill(checkbox, /"[^"]*(?<![-\w])checked:bg-([a-z-]+)/),
	},
	{
		name: "Switch",
		fill: () => checkedFill(toggle, /"[^"]*data-\[state=checked\]:bg-([a-z-]+)/),
	},
];

const BAR = 3.0;

describe("the scan itself", () => {
	it("found the dark schemes and both controls' checked fills and the switch's edge", () => {
		// A stylesheet that stopped matching would make every case below vacuous.
		expect(DARK_SCHEMES.length).toBeGreaterThan(5);
		expect(DARK_SCHEMES.map((s) => s.scheme)).toContain("default");
		for (const control of CONTROLS) expect(control.fill().length).toBeGreaterThan(0);
		expect(switchCheckedEdge().length).toBeGreaterThan(0);
	});
});

describe.each(CONTROLS)("$name's checked fill", ({ fill }) => {
	it("is the fill token, which holds one value in both themes", () => {
		expect(fill()).toBe("primary-fill");
	});

	it.each(DARK_SCHEMES.map((s) => [s.scheme, s.body] as const))(
		"carries a white mark at %s dark",
		(_scheme, body) => {
			const token = fill();
			const painted = declared(body, token);
			expect(painted, `--${token} is not declared in this scheme`).toBeDefined();
			const mark = declared(body, "primary-foreground")!;
			expect(contrast(toRgb(mark), toRgb(painted!))).toBeGreaterThanOrEqual(BAR);
		}
	);
});

describe("Switch's checked edge", () => {
	it("is the accent token, which brightens in dark", () => {
		expect(switchCheckedEdge()).toBe("primary");
	});

	it.each(DARK_SCHEMES.map((s) => [s.scheme, s.body] as const))(
		"clears 3:1 against the card at %s dark",
		(_scheme, body) => {
			const token = switchCheckedEdge();
			const edge = darkToken(body, token);
			const card = darkToken(body, "card");
			expect(edge, `--${token} is not declared in this scheme`).toBeDefined();
			expect(card, "--card is not declared in the default dark block").toBeDefined();
			expect(contrast(toRgb(edge!), toRgb(card!))).toBeGreaterThanOrEqual(BAR);
		}
	);
});
