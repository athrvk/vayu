/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Icons are sized by token, not by an arbitrary 3.5 step (issue #1693).
 *
 * `--spacing-icon` (16px) and `--spacing-icon-sm` (12px) are the app's two
 * icon sizes, and `size-icon`/`size-icon-sm` were already the dominant form -
 * but a third, tokenless size survived at 152 call sites as `h-3.5 w-3.5`,
 * `w-3.5 h-3.5` and `size-3.5` (14px), doing the same job in the same rows:
 * a chip's status glyph, a button's leading icon, a row's trailing action.
 * Three spellings of one intent is exactly what a token exists to collapse,
 * and an arbitrary value is a fixed length besides, so those icons were the
 * only ones in the app that could not follow a token if it ever moves.
 *
 * The sweep normalised all of them to `size-icon-sm`, which is the 12px
 * token rather than the 14px they drew - a deliberate 2px step down onto the
 * scale, not a translation. `size-icon` was wrong for them: every one of
 * these sits beside `text-sm` or smaller text where the 16px default reads a
 * size too loud, which is why they were written smaller than the default in
 * the first place.
 *
 * Scope is the whole `.tsx` tree because the defect is the spelling, not a
 * particular pane. The bare `h-3.5` in `PaletteResults`' `h-icon-sm w-0.5`
 * rail was the one non-icon use and moved to the token too, so this can ban
 * the pair without a single exemption.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

// `h-3.5 w-3.5`, `w-3.5 h-3.5`, `size-3.5`, with or without a variant prefix.
const RAW_ICON_SIZE = /\b(?:h-3\.5 w-3\.5|w-3\.5 h-3\.5|(?:[a-z-]+:)*size-3\.5)\b/g;

function scannedFiles(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx$/.test(f))
		.map((f) => join(srcRoot, f));
}

describe("icon sizes use the spacing tokens, not an arbitrary 3.5", () => {
	it("scans a non-empty set of files", () => {
		// A guard that reads nothing passes forever and reads as coverage.
		expect(scannedFiles().length).toBeGreaterThan(100);
	});

	it("finds no raw 3.5 icon sizes", () => {
		// Mutation check: put `h-3.5 w-3.5` back on any icon and this reds.
		const offences: string[] = [];

		for (const file of scannedFiles()) {
			const source = readFileSync(file, "utf8");
			const code = stripComments(source).split(/\r?\n/);
			source.split(/\r?\n/).forEach((line, i) => {
				const hits = code[i]?.match(RAW_ICON_SIZE);
				if (hits) {
					offences.push(`${relative(srcRoot, file)}:${i + 1}  ${line.trim()}`);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});
