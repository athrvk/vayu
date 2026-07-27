/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every key in `TIMING` must have a reader.
 *
 * `AUTO_SAVE_DELAY_MS: 3000` sat here with none. Worse than absent: the real
 * auto-save delay is a user setting defaulting to 5000
 * (`constants/client-settings.ts`), so the dead entry was two seconds wrong,
 * and CLAUDE.md points at this file as the home for millisecond values. It was
 * found by accident while tracing an unrelated bug.
 *
 * "Written but never read" is the defect this codebase repeats most, and it is
 * a wiring bug by nature - no unit test of either side can see it. So this
 * guard scans instead.
 *
 * Two traps it has to avoid, both of which this repo has been bitten by:
 *
 * - **A scan that scanned nothing passes.** One guard here read an empty string
 *   for weeks. Both the key list and the file list are asserted non-empty
 *   before anything is checked.
 * - **A comment is not a reader.** The three surviving mentions of the deleted
 *   constant were all prose about its deletion. Comments are stripped first, or
 *   this file's own docblock would keep any key it names alive.
 *
 * Both consumption styles count: `TIMING.KEY` and
 * `const { KEY } = TIMING` (`useSaveManager` uses the latter).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const APP = resolve(SRC, "..");
const TIMING_FILE = join(SRC, "config", "timing.ts");

/** Source roots a TIMING reader could live in. */
const ROOTS = [SRC, join(APP, "electron")];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** Block and line comments, so prose about a key does not keep it alive. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const timingSource = readFileSync(TIMING_FILE, "utf8");

/** Top-level keys of the `TIMING` object literal - one tab of indent. */
const keys = [...stripComments(timingSource).matchAll(/^\t([A-Z][A-Z0-9_]*)\s*:/gm)].map(
	(m) => m[1]
);

const readerFiles = ROOTS.flatMap(walk).filter(
	(f) => f !== TIMING_FILE && !f.endsWith("timing-keys-have-readers.test.ts")
);

const haystack = readerFiles.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

describe("the scan itself", () => {
	// A guard that scanned nothing would pass every assertion below.
	it("found the TIMING keys", () => {
		expect(keys.length).toBeGreaterThan(5);
		expect(keys).toContain("TOAST_EXIT_MS");
	});

	it("found source files to search", () => {
		expect(readerFiles.length).toBeGreaterThan(100);
		expect(haystack.length).toBeGreaterThan(100_000);
	});

	it("does not count a mention inside a comment", () => {
		// The bug that made this guard necessary was invisible precisely because
		// the only surviving mentions were prose.
		expect(stripComments("// TIMING.GHOST_MS\n/* TIMING.GHOST_MS */")).not.toContain(
			"GHOST_MS"
		);
	});
});

describe("every TIMING key", () => {
	it("is read somewhere", () => {
		const dead = keys.filter((k) => !haystack.includes(k));
		expect(dead).toEqual([]);
	});

	it("no longer includes the auto-save delay, which is a user setting", () => {
		// It lives in `constants/client-settings.ts` as `autoSave.delayMs`,
		// is chosen in Settings → General, and is read by `useSaveManager`.
		expect(keys).not.toContain("AUTO_SAVE_DELAY_MS");
	});
});
