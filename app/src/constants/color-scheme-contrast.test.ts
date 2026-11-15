/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every accent scheme reads at 4.5:1 in both themes, and keeps the
 * `{{variable}}` states apart (#3499).
 *
 * Two jobs, two tokens. `--primary` is accent text (`text-primary`) and has
 * to clear 4.5 on the opaque surfaces (card, panel, background, muted,
 * accent); in light the darkest of them, `--muted` / `--accent` at 93%, is
 * what sets it. `--primary-fill` is a solid under a white label
 * (`--primary-foreground`) and has to clear 4.5 under it. `--primary-text`,
 * the accent as a label, is held to the same bar: it aliases `--primary` in
 * most schemes and is a literal in the rest.
 *
 * Three opaque tokens answer the same two jobs where a translucent alpha used
 * to (#3515): `--primary-fill-hover` is the fill's hover, under the same white
 * label, and `--primary-tint` / `--primary-tint-hover` are the surfaces accent
 * text sits on in a chip and its hover. Accent text (`--primary-text`,
 * `--primary`) and `--foreground` have to clear 4.5 on both tints.
 *
 * A variable token is resolved, empty, undefined, deferred or an undeclared
 * `data.*` column (warning), and the accent is one of those colours, so a
 * scheme can move a state onto its neighbour. Two
 * states under 0.10 OKLab apart read as one colour; such a pair has to differ
 * in a cue that is not colour (an underline style).
 *
 * Values come out of `index.css` through the cascade the browser applies, so a
 * retuned scheme is measured rather than assumed. The unattributed default
 * (`:root` / `.dark` alone) is measured too: it is what paints before the
 * scheme attribute lands.
 */

import { describe, it, expect } from "vitest";
import { indexCss as css, monacoTokenPaint } from "@/lib/css-tokens.testkit";
import {
	THEMES,
	contrastRatio,
	oklabDistance,
	relativeLuminance,
	resolveToken,
	type Theme,
} from "@/lib/contrast-math.testkit";
import { variableTokenClass } from "@/lib/monaco-variable-tokens";
import type { VariableTokenKind } from "@/lib/variable-token-kind";
import { COLOR_SCHEMES } from "./color-schemes";

const BAR = 4.5;
/** Under this OKLab distance a hover tint reads as no change (the smallest shipped is 0.027). */
const MIN_TINT_STEP = 0.02;
const SURFACES = ["card", "panel", "background", "muted", "accent"] as const;
const TEXT_TOKENS = ["primary", "primary-text"] as const;
const TINTS = ["primary-tint", "primary-tint-hover"] as const;

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

describe("the white label on the hover fill", () => {
	it.each(CASES)("%s %s clears 4.5:1 and is darker than the fill", (_label, theme, scheme) => {
		const label = resolveToken("primary-foreground", scheme, theme);
		const hover = resolveToken("primary-fill-hover", scheme, theme);
		expect(contrastRatio(label, hover)).toBeGreaterThanOrEqual(BAR);
		// A hover that is not darker than the fill is no state change.
		expect(relativeLuminance(hover)).toBeLessThan(
			relativeLuminance(resolveToken("primary-fill", scheme, theme))
		);
	});
});

describe("text on the accent tints", () => {
	it.each(CASES)("%s %s clears 4.5:1 on both tints", (_label, theme, scheme) => {
		const misses: string[] = [];
		for (const tint of TINTS) {
			const ground = resolveToken(tint, scheme, theme);
			for (const token of [...TEXT_TOKENS, "foreground"]) {
				const ratio = contrastRatio(resolveToken(token, scheme, theme), ground);
				if (ratio < BAR) misses.push(`--${token} on --${tint}: ${ratio.toFixed(2)}`);
			}
		}
		expect(misses).toEqual([]);
	});

	it.each(CASES)("%s %s: the hover tint is a step from the tint", (_label, theme, scheme) => {
		const distance = oklabDistance(
			resolveToken("primary-tint", scheme, theme),
			resolveToken("primary-tint-hover", scheme, theme)
		);
		expect(distance).toBeGreaterThanOrEqual(MIN_TINT_STEP);
	});
});

/**
 * The painter's own answer for each state: Monaco's class, which
 * `EditableVariable.test.tsx` holds the field painter equal to, and for the
 * undeclared `data.*` column `variable-token-classes.test.ts` holds
 * `DATA_TOKEN_TONE_CLASS` equal to. The runtime-muted class is left out: it
 * is `empty`'s colour and cue by design (nothing to define, so muted), which
 * the rule below would call a collision.
 */
const KINDS: { state: string; kind: VariableTokenKind }[] = [
	{ state: "resolved", kind: { state: "resolved", info: null } },
	{ state: "empty", kind: { state: "empty", info: null } },
	{ state: "undefined", kind: { state: "undefined", info: null } },
	{ state: "deferred", kind: { state: "deferred", info: null } },
	{
		state: "warning",
		kind: { state: "runtime", tone: "warning", description: "", note: "" },
	},
];
const STATES = KINDS.map(({ state, kind }) => ({
	state,
	...monacoTokenPaint(variableTokenClass(kind)),
}));

const SAME_COLOUR = 0.1;

/** Every state pair in one scheme and theme whose colours sit under 0.10 OKLab apart. */
function closePairs(scheme: string | null, theme: Theme) {
	const out: { pair: string; distance: number; sameCue: boolean }[] = [];
	for (let i = 0; i < STATES.length; i++) {
		for (let j = i + 1; j < STATES.length; j++) {
			const [a, b] = [STATES[i], STATES[j]];
			const distance = oklabDistance(
				resolveToken(a.colour!, scheme, theme),
				resolveToken(b.colour!, scheme, theme)
			);
			if (distance >= SAME_COLOUR) continue;
			out.push({
				pair: `${a.state} / ${b.state}`,
				distance,
				sameCue: a.underline === b.underline,
			});
		}
	}
	return out;
}

describe("the variable states", () => {
	it("read a colour for every state", () => {
		for (const { state, colour } of STATES) expect(colour, state).not.toBeNull();
	});

	it.each(CASES)(
		"%s %s: no pair is told apart by under 0.10 OKLab alone",
		(_l, theme, scheme) => {
			expect(closePairs(scheme, theme).filter((p) => p.sameCue)).toEqual([]);
		}
	);

	it("has pairs that only the cue separates, so the case above is not vacuous", () => {
		const close = CASES.flatMap(([, theme, scheme]) => closePairs(scheme, theme));
		expect(close.length).toBeGreaterThan(0);
	});
});
