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
 * Using the fill token as a foreground fails AA. Measured live on `bg-card`
 * (contrast ratio; 4.5 is the floor for normal text, 3.0 for icons):
 *
 *   family           light bare   light -text   dark bare   dark -text
 *   destructive         4.87         5.48         1.73         5.40
 *   success             3.33         5.71         7.46         8.81
 *   warning             2.13         5.46         8.13         9.81
 *   status-success      2.30         5.71         7.53         8.81
 *   status-error        3.78         5.88         4.59         5.85
 *   status-stopped      2.79         5.73         6.23         7.40
 *   status-running      3.64         5.99         4.77         6.75
 *
 * `destructive` is the only family that fails in dark; the rest fail in light.
 * That inversion is the tell that this is not a dark-mode bug - it is the fill
 * token standing in for the foreground one, which shows up in whichever mode the
 * fill happens to sit closest to the surface behind it.
 *
 * So `text-<family>` is banned, including `hover:`/`focus:` prefixes and the
 * `/NN` opacity forms - a faded `-text` is no safer than a solid bare token, and
 * these are error and status affordances where fading works against the point.
 * `bg-*`, `border-*` and `*-foreground` (the paired foreground for a solid fill)
 * are all correct uses of the bare token and are left alone.
 *
 * `status-warning` is deliberately absent from the list below: it has no `-text`
 * variant, because bare already measures 17.72 / 15.78 - banning it would only
 * force churn towards a token that does not exist.
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

const sources: Record<string, string> = import.meta.glob("/src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

/** Families with a `-text` foreground variant. One line each to add another. */
const FAMILIES = [
	"destructive",
	"success",
	"warning",
	"status-success",
	"status-error",
	"status-stopped",
	"status-running",
];

/**
 * `text-<family>` not followed by `-` or a word character, so `-text` and
 * `-foreground` are excluded while `text-<family>/80` is caught (`/` is
 * neither). Any variant prefix (`hover:`, `focus:`, `dark:`) is allowed to
 * precede it - those are exactly the sneaky cases.
 */
const bareForeground = (family: string) => new RegExp(`\\btext-${family}(?![-\\w])`);

describe("status colours use the -text token for foreground", () => {
	it("finds -text utilities to check (guards the scan itself)", () => {
		const total = Object.values(sources).reduce<number>(
			(n, src) =>
				n +
				((src as string).match(
					/\btext-(?:[a-z-]*?)(?:destructive|success|warning|error|stopped|running)-text\b/g
				)?.length ?? 0),
			0
		);
		expect(total).toBeGreaterThan(50);
	});

	for (const family of FAMILIES) {
		it(`uses no bare \`text-${family}\`, which is the fill token`, () => {
			const pattern = bareForeground(family);
			const offenders: string[] = [];
			for (const [path, src] of Object.entries(sources)) {
				if (path.includes(".test.")) continue;
				(src as string).split("\n").forEach((line, i) => {
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
			expect(offenders).toEqual([]);
		});
	}
});
