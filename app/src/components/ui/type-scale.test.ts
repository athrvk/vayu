/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Font sizes come from the scale, not from nudging a number until it looks right.
 *
 * The app had **182 arbitrary sizes across 11 distinct values**, and the damage
 * was not the count - it was that half of them duplicated a step that already
 * existed. `text-[12px]` is exactly `text-xs` and `text-[13px]` is exactly
 * `text-sm` (`--text-sm` is redefined to 13px in `index.css`), so those 52 call
 * sites rendered at the documented size while **skipping its paired
 * line-height**: 34 of 36 and 13 of 16 set no `leading-*`, so they inherited
 * whatever the parent had while the 157 `text-sm` siblings got 18px. Same size,
 * different rhythm, for no reason anyone chose.
 *
 * Seven were half-pixel - `text-[10.5px]`, `text-[11.5px]` - which no scale
 * contains and which render soft on a non-retina display. Those are the
 * signature of adjusting by eye.
 *
 * `text-[10px]` and `text-[11px]` stay allowed: both are in the documented table
 * as the micro/badge and eyebrow sizes, and a dense developer tool genuinely
 * needs steps below 12px. They are permitted *by name* here rather than by
 * pattern, so a twelfth value cannot arrive unnoticed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This file sits in `src/components/ui`, so `src/` is two levels up.
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The arbitrary sizes that are part of the scale, per
 * `docs/design-system.md` -> Type Scale Conventions. Everything else must use a
 * named utility so it carries a line-height.
 */
const ALLOWED_ARBITRARY = new Set([
	"text-[10px]", // micro / badge
	"text-[11px]", // section label / eyebrow
	"text-[22px]", // secondary metric value
	"text-[34px]", // hero metric value
]);

const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

describe("type scale", () => {
	it("scans a real set of files", () => {
		// A guard that matches nothing passes silently and reads as coverage.
		expect(files.length).toBeGreaterThan(150);
	});

	it("uses no font size outside the scale", () => {
		const offences: string[] = [];

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			source.split("\n").forEach((line, i) => {
				for (const m of line.matchAll(/text-\[[\d.]+px\]/g)) {
					if (ALLOWED_ARBITRARY.has(m[0])) continue;
					offences.push(
						`${relative(".", file)}:${i + 1}  ${m[0]} is not on the scale. ` +
							`Use text-xs (12), text-sm (13), text-md (15), text-base (16), ` +
							`or one of ${[...ALLOWED_ARBITRARY].join(", ")}.`
					);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});

	it("has no half-pixel size anywhere", () => {
		// Called out separately because it is the clearest signal of a value
		// arrived at by eye, and it renders soft on a non-retina display.
		const half: string[] = [];
		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			for (const m of source.matchAll(/text-\[\d+\.\d+px\]/g)) {
				half.push(`${relative(".", file)}  ${m[0]}`);
			}
		}
		expect(half.join("\n")).toBe("");
	});
});

describe("the scale steps carry paired line-heights", () => {
	/**
	 * A size without a line-height inherits the parent's, which is how the same
	 * size ended up with two different rhythms. Every step redefined in `@theme`
	 * must declare both.
	 */
	const css = readFileSync(join(srcRoot, "index.css"), "utf8");

	it("read the stylesheet", () => {
		expect(css.length).toBeGreaterThan(1000);
	});

	it.each(["sm", "md"])("--text-%s declares a line-height", (step) => {
		expect(css).toContain(`--text-${step}:`);
		expect(css).toContain(`--text-${step}--line-height:`);
	});
});
