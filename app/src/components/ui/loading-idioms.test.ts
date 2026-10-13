/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A spinner is the `Loader2` glyph, never a hand-drawn ring (issue #2073).
 *
 * The "Loading" rule in docs/design-system.md names three shapes (skeleton,
 * inline `Loader2`, progress view). Four `div`s drawn as a ring - a bordered
 * circle with a transparent top edge - were a fourth idiom that carried none of
 * the rule's fixes: a skeleton that holds the layout, a glyph that follows the
 * icon-size tokens. `border-t-transparent` is how every one of them was drawn.
 *
 * `components/ui` is the one tree exempt: a primitive that needs a transparent
 * edge for its own reasons is not a loading idiom. None does today.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");
const uiRoot = here + sep;

const RING_SPINNER = /\bborder-t-transparent\b/;

function scannedFiles(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx$/.test(f))
		.map((f) => join(srcRoot, f))
		.filter((f) => !f.startsWith(uiRoot));
}

describe("spinners are Loader2, not a hand-drawn ring", () => {
	it("scans a non-empty set of files", () => {
		// A guard that reads nothing passes forever and reads as coverage.
		expect(scannedFiles().length).toBeGreaterThan(100);
	});

	it("finds no border-t-transparent outside components/ui", () => {
		// Mutation check: put a `border-t-transparent` ring back on any pane and this reds.
		const offences: string[] = [];

		for (const file of scannedFiles()) {
			const source = readFileSync(file, "utf8");
			const code = stripComments(source).split(/\r?\n/);
			source.split(/\r?\n/).forEach((line, i) => {
				if (RING_SPINNER.test(code[i] ?? "")) {
					offences.push(`${relative(srcRoot, file)}:${i + 1}  ${line.trim()}`);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});
