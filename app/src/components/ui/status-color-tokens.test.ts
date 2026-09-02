/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Status colours have two tokens, and only one of them is a foreground colour.
 *
 * Every status family ships a bare token and a `-text` token. The bare one is a
 * *fill* - it is what `bg-destructive`, `border-warning` and the run-status dots
 * paint, and it is tuned to look right as an area of colour. The `-text` one is
 * the readable *foreground*, darkened in light mode and lightened in dark so it
 * clears AA as small text or a small glyph.
 *
 * Using the fill token as a foreground fails AA. The measured ratios live in
 * `docs/design-system.md` ("The bare token is the fill"), which is the one
 * record of them - every family fails at one end or the other, `destructive`
 * in dark, the three mode-consistent HTTP-status indicators (`status-warning`,
 * `status-redirect`, `status-no-response`) in both, the rest in light. That
 * spread is the tell
 * that this is not a dark-mode bug: it is the fill token standing in for the
 * foreground one, and which mode it breaks in just depends on where that fill
 * sits relative to the surface behind it.
 *
 * So `text-<family>` is banned, including `hover:`/`focus:` prefixes and the
 * `/NN` opacity forms - a faded `-text` is no safer than a solid bare token, and
 * these are error and status affordances where fading works against the point.
 * `bg-*`, `border-*` and `*-foreground` (the paired foreground for a solid fill)
 * are all correct uses of the bare token and are left alone.
 *
 * **The families are read out of `index.css`, not listed here.** A hand-written
 * list held seven while the stylesheet had grown to ten, so `status-redirect`,
 * `status-no-response` and `status-warning` were guarded by nothing - and the
 * comment that had explained `status-warning`'s absence ("it has no `-text`
 * variant") was describing a stylesheet that no longer existed (#1253). A
 * family is now whatever declares both halves in the base palette, so the next
 * token pair arrives guarded.
 *
 * **Known blind spot: inline styles.** This scans for the `text-<family>` class,
 * so `style={{ color: "hsl(var(--warning))" }}` walks straight past it.
 * `SaturationCard` carried exactly that for a while - 22px bold on `--warning`,
 * 2.14 against the card - and a parallel audit, not this guard, is what found it.
 *
 * An inline-style rule was tried and removed. A regex for `color:` cannot tell a
 * CSS declaration from an object property named `color`, and the codebase is full
 * of the latter feeding a `background` - the ErrorRate legend swatches and the
 * timing-waterfall bars are both correct uses that it flagged. Worse, it would
 * not have caught the real case anyway, because the literal was assigned to a
 * `const` and passed in as `style={{ color }}`. A scan that produces false
 * positives *and* misses the bug it was written for is worse than none, so the
 * blind spot is written down here instead of papered over.
 */

import { describe, it, expect } from "vitest";
import { familiesWithTextPair, indexCss } from "@/lib/css-tokens.testkit";

const sources: Record<string, string> = import.meta.glob("/src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

/** Families with a `-text` foreground variant, as `index.css` declares them. */
const FAMILIES = familiesWithTextPair();

/**
 * `text-<family>` not followed by `-` or a word character, so `-text` and
 * `-foreground` are excluded while `text-<family>/80` is caught (`/` is
 * neither). Any variant prefix (`hover:`, `focus:`, `dark:`) is allowed to
 * precede it - those are exactly the sneaky cases.
 */
const bareForeground = (family: string) => new RegExp(`\\btext-${family}(?![-\\w])`);

/** Every place a scanned source uses `family`'s fill token as a foreground. */
function bareForegroundUses(files: Record<string, string>, family: string): string[] {
	const pattern = bareForeground(family);
	const offenders: string[] = [];
	for (const [path, src] of Object.entries(files)) {
		if (path.includes(".test.")) continue;
		src.split("\n").forEach((line, i) => {
			// Prose in comments may name the class; only code is scanned.
			// The token can sit far from `className` - a ternary branch on
			// its own line, a helper returning a class string - so the line
			// is scanned whole rather than only inside a `className=`.
			const code = line.replace(/^\s*(\/\/|\/?\*).*$/, "");
			if (pattern.test(code)) {
				offenders.push(`${path}:${i + 1}: ${line.trim().slice(0, 88)}`);
			}
		});
	}
	return offenders;
}

/** A stylesheet shaped like `index.css`'s base palette, for the cases below. */
const palette = (declarations: string) => `@layer base {\n\t:root {\n${declarations}\n\t}\n}\n`;

describe("status colours use the -text token for foreground", () => {
	it("derives its families from the stylesheet (guards the derivation)", () => {
		expect(indexCss.length).toBeGreaterThan(1000);
		// Empty would make every case below vanish rather than fail.
		expect(FAMILIES.length).toBeGreaterThan(0);
		expect(FAMILIES).toContain("status-warning");
	});

	it("takes a family only while the stylesheet declares both halves", () => {
		const both = "\t\t--status-warning: 38 92% 36%;\n\t\t--status-warning-text: 38 90% 30%;";
		expect(familiesWithTextPair(palette(both))).toEqual(["status-warning"]);

		const bareOnly = "\t\t--status-warning: 38 92% 36%;";
		expect(familiesWithTextPair(palette(bareOnly))).toEqual([]);
	});

	it("leaves out a family whose `-text` only aliases the bare token", () => {
		// `--primary-text: var(--primary)` is the live case: same colour, so
		// there is no more readable variant to prefer and nothing to ban.
		const aliased = "\t\t--primary: 24 90% 46%;\n\t\t--primary-text: var(--primary);";
		expect(familiesWithTextPair(palette(aliased))).toEqual([]);
	});

	it("finds -text utilities to check (guards the scan itself)", () => {
		const used = new RegExp(`\\btext-(?:${FAMILIES.join("|")})-text\\b`, "g");
		const total = Object.values(sources).reduce<number>(
			(n, src) => n + ((src as string).match(used)?.length ?? 0),
			0
		);
		expect(total).toBeGreaterThan(50);
	});

	it("reports the bare token where a source uses one", () => {
		const path = "/src/components/ui/fixture.tsx";
		const bare = { [path]: `<span className="text-status-warning">4xx</span>` };
		expect(bareForegroundUses(bare, "status-warning")).toHaveLength(1);

		const fixed = { [path]: `<span className="text-status-warning-text">4xx</span>` };
		expect(bareForegroundUses(fixed, "status-warning")).toEqual([]);
	});

	for (const family of FAMILIES) {
		it(`uses no bare \`text-${family}\`, which is the fill token`, () => {
			expect(bareForegroundUses(sources, family)).toEqual([]);
		});
	}
});
