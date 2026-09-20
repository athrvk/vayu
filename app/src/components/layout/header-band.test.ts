/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A chrome band states its height as a token, never as an arbitrary literal
 * (issue #1688).
 *
 * `--spacing` scales rhythm and the `band` steps deliberately do not ride it
 * (see `chrome-floors.test.ts` and the "Chrome, Target and Icon Floors" table
 * in `docs/design-system.md`). An arbitrary `h-[52px]` is worse than a wrong
 * token: it is a fixed length, so the row is the one piece of chrome in the app
 * that cannot follow anything, and a reader cannot tell a measured band from a
 * number somebody nudged until it looked right.
 *
 * The rule is stated the narrow way it can actually be enforced: an element
 * that paints a band - a bottom rule *and* a panel fill - must not set its
 * height with a bracketed pixel literal. That leaves the deliberate literals
 * alone (`h-[2px]` underlines, `h-[1px]` separators, editor pane heights, the
 * `h-[18px]` keycap) without an allowlist to keep in step, because none of them
 * is a band.
 *
 * Source-scanned, not rendered: the claim is about every band in the tree, and
 * jsdom does no layout, so a class string read off disk is the only evidence
 * available. `h-[var(--...)]` is a token reference, not a literal, and passes -
 * the tab strip and the drawer header size themselves that way.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A `className="..."` / `className={cn("...")}` string, one per match. */
const CLASS_STRINGS = /"([^"\n]*)"/g;
/** `h-[32px]` / `min-h-[52px]`, but not `h-[var(--tabstrip-height)]`. */
const LITERAL_HEIGHT = /\b(?:min-)?h-\[\d+(?:\.\d+)?px\]/;

function paintsABand(classes: string): boolean {
	return /\bborder-b\b/.test(classes) && /\bbg-panel\b/.test(classes);
}

describe("chrome bands size themselves with a token", () => {
	const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

	it("scans a real tree", () => {
		expect(files.length).toBeGreaterThan(200);
	});

	it("finds bands to check", () => {
		// A scan of nothing satisfies every assertion made of it. The app has
		// several of these rows: the URL bar, the dashboard header, the
		// collection-detail header, the tab strip, the pane tab bands.
		const bands = files.flatMap((file) =>
			[...stripComments(readFileSync(join(srcRoot, file), "utf8")).matchAll(CLASS_STRINGS)]
				.map((m) => m[1])
				.filter(paintsABand)
		);
		expect(bands.length).toBeGreaterThanOrEqual(4);
	});

	it("never sets a band's height with a bracketed pixel literal", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = stripComments(readFileSync(join(srcRoot, file), "utf8"));
			for (const m of source.matchAll(CLASS_STRINGS)) {
				const classes = m[1];
				if (paintsABand(classes) && LITERAL_HEIGHT.test(classes)) {
					offenders.push(`${file}: ${classes}`);
				}
			}
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});
});
