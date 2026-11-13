/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A focus indicator is a UI component boundary: WCAG 1.4.11 asks 3:1 against
 * what it is drawn over (#3499).
 *
 * `.focus-row` painted its 2px outline at `--primary / 0.3`, which over a card
 * composites to a colour well under the bar in most schemes. It now paints the
 * full `--ring`, as the baseline outline and the disclosure chevrons already
 * did. The test reads the alpha and the token off the rule itself rather than
 * restating them, so putting an alpha back, or pointing the outline at a
 * lighter token, fails here instead of passing a restated constant.
 *
 * Measured over `--card`, `--panel` and `--background`: the three surfaces a
 * tree row sits on. Every accent scheme, both themes, plus the unattributed
 * default the stylesheet declares on `:root` / `.dark`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { COLOR_SCHEMES } from "@/constants/color-schemes";
import { contrast, over, toRgb, type Hsl } from "@/lib/contrast.testkit";
import { indexCss, ruleBody } from "@/lib/css-tokens.testkit";

const BAR = 3.0;
const SURFACES = ["card", "panel", "background"] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/**
 * The rule that carries the indicator. Two selectors share it (the row itself
 * focused, or a control inside it), and `ruleBody` finds it by the second.
 */
const ROW_RULE = ruleBody(":where(.focus-row):has(:focus-visible:not(.focus-self))");
const ROW_SELECTORS = /:where\(\.focus-row\):focus-visible,\s*:where\(\.focus-row\):has\(/;

function declared(body: string, token: string): Hsl | undefined {
	const m = new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(body);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** What the outline paints: the `--token` it names and the alpha it applies. */
function outlineOf(rule: string): { token: string; alpha: number } {
	const m = /outline:\s*[\d.]+px solid hsl\(var\(--([a-z-]+)\)(?:\s*\/\s*([\d.]+))?\)/.exec(rule);
	if (!m) throw new Error(`no outline colour in rule: ${rule}`);
	return { token: m[1], alpha: m[2] === undefined ? 1 : Number(m[2]) };
}

/** The block a theme and scheme declare their tokens in; `default` is the bare `:root` / `.dark`. */
function blockFor(theme: Theme, scheme: string): string {
	const base = theme === "dark" ? ".dark" : ":root";
	const selector =
		scheme === "default"
			? base
			: `${base === ":root" ? "" : base}[data-color-scheme="${scheme}"]`;
	return ruleBody(selector);
}

const SCHEMES = ["default", ...COLOR_SCHEMES.map((s) => s.value)];

describe("the scan itself", () => {
	it("found the stylesheet, the row rule and a block per scheme and theme", () => {
		// An empty match would make every case below pass without measuring.
		expect(indexCss.length).toBeGreaterThan(1000);
		expect(ROW_RULE.length).toBeGreaterThan(0);
		expect(SCHEMES.length).toBeGreaterThan(5);
		for (const theme of THEMES) {
			for (const scheme of SCHEMES) {
				const body = blockFor(theme, scheme);
				expect(declared(body, "ring"), `--ring in ${theme} ${scheme}`).toBeDefined();
			}
		}
		for (const theme of THEMES) {
			const base = blockFor(theme, "default");
			for (const surface of SURFACES) {
				expect(declared(base, surface), `--${surface} in ${theme}`).toBeDefined();
			}
		}
	});

	it("shares the one rule between the focused row and a focused control inside it", () => {
		// Were the first selector split off into a rule of its own, it could keep
		// the faint outline while the rule read above passes.
		expect(indexCss).toMatch(ROW_SELECTORS);
	});
});

describe(".focus-row's outline", () => {
	const { token, alpha } = outlineOf(ROW_RULE);

	it("is the focus ring token at full strength", () => {
		expect(token).toBe("ring");
		expect(alpha).toBe(1);
	});

	describe.each(THEMES)("%s theme", (theme) => {
		const surfaces = blockFor(theme, "default");

		it.each(SCHEMES)("clears 3:1 on card, panel and canvas in %s", (scheme) => {
			const ring = declared(blockFor(theme, scheme), token);
			expect(ring, `--${token} in ${theme} ${scheme}`).toBeDefined();
			for (const surface of SURFACES) {
				const ground = declared(surfaces, surface)!;
				expect(
					contrast(over(ring!, ground, alpha), toRgb(ground)),
					`${scheme} ${theme} ring on --${surface}`
				).toBeGreaterThanOrEqual(BAR);
			}
		});
	});
});

describe("the disclosure chevrons' own focus ring", () => {
	// A literal class on each, so a scan sees it. They paint a Tailwind ring, not
	// the row rule, and used to name `--primary` at 0.3 alpha the same way.
	const CHEVRONS = [
		"modules/collections/CollectionItem.tsx",
		"components/shared/ElementList/index.tsx",
	];
	const here = dirname(fileURLToPath(import.meta.url));

	it.each(CHEVRONS)("%s rings with --ring, not a primary alpha", (file) => {
		const source = readFileSync(join(here, "..", file), "utf8");
		const rings = [...source.matchAll(/focus-visible:ring-(?!2\b)[^\s"'`]+/g)].map((m) => m[0]);
		expect(rings.length).toBeGreaterThan(0);
		expect(rings).toEqual(rings.map(() => "focus-visible:ring-ring"));
	});
});
