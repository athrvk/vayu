/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A chord is defined once, in `constants/shortcuts.ts`.
 *
 * That is the promise this file's own header makes, and six surfaces were
 * quietly breaking it: the Dock spelled out five of the Shell's chords as
 * independent `formatChord({ mod: true, shift: true, key: "E" })` literals, and
 * the response pane assembled Send from `modKey` plus a "↵" of its own. Nothing
 * but a comment tied any of them to the handler, so a rebinding would have left
 * the app advertising a chord it no longer listened for (#938).
 *
 * The guard is a scan because the defect is invisible in behaviour: the labels
 * were *correct*, they were just a second copy. Behavioural tests cannot see a
 * duplicate that currently agrees.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

/** Everything that renders, plus the hooks and libs behind it. */
const SCANNED = ["components/**/*.{ts,tsx}", "modules/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}"];

function scannedFiles(): string[] {
	return SCANNED.flatMap((pattern) => globSync(pattern, { cwd: srcRoot }))
		.filter((f) => !/\.test\.[jt]sx?$/.test(f))
		.map((f) => join(srcRoot, f));
}

/** `formatChord({ ... })` / `chordKeys({ ... })` - a chord built at the call site. */
const INLINE_CHORD = /\b(?:formatChord|chordKeys|matchesChord)\s*\(\s*(?:[^,()]*,\s*)?\{/g;

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("every displayed chord reads its definition", () => {
	it("scans a non-empty set of files", () => {
		// A guard that cannot fail reads as coverage and is worse than none.
		expect(scannedFiles().length).toBeGreaterThan(100);
	});

	it("finds no chord assembled at a call site", () => {
		const offenders = scannedFiles().filter((file) =>
			stripComments(readFileSync(file, "utf8")).match(INLINE_CHORD)
		);
		expect(offenders).toEqual([]);
	});

	it("catches an inline chord when there is one", () => {
		// The scan's own mutation check: the pattern above has to match the
		// shape it bans, or the empty result means nothing.
		const sample = stripComments(`
			// formatChord({ mod: true, key: "Q" }) in a comment does not count
			const hint = formatChord({ mod: true, shift: true, key: "E" });
		`);
		expect(sample.match(INLINE_CHORD)).toHaveLength(1);
	});
});
