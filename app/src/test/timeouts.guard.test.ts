/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A test file names no wall-clock budget of its own (see `timeouts.ts`).
 *
 * Every hand-sized `{ timeout: N }` this suite carried was a measurement on one
 * machine multiplied by a guess, and the guesses ran out on CI: 5s, 10s, 15s and
 * 20s budgets each failed a healthy run on a loaded runner. The suite-wide
 * defaults are sized for the slowest leg; a case that needs more than they give
 * is doing a whole build and says so with `BUILD_TEST_TIMEOUT_MS`.
 *
 * The scan matches an options object holding nothing but a numeric `timeout`,
 * which is the shape both `it(name, { timeout }, fn)` and `waitFor(fn, {
 * timeout })` take. A fixture's own data (`types: { timeout: 2 }`, a payload's
 * `timeout: 5000` among other fields) is not that shape and is left alone.
 */

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TEST_FILES = ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"];

/** `{ timeout: 15_000 }`, on one line or several, not preceded by `types:`. */
const LITERAL_BUDGET = /(?<!types:\s*)\{\s*timeout:\s*[\d_]+\s*,?\s*\}/g;

function literalBudgets(): string[] {
	const files = TEST_FILES.flatMap((pattern) => globSync(pattern, { cwd: appRoot }))
		// This file spells the refused shape to prove the pattern matches it.
		.filter((file) => !file.endsWith("timeouts.guard.test.ts"));
	// Something was read: a pattern that matched nothing would pass this forever.
	expect(files.length).toBeGreaterThan(500);
	const found: string[] = [];
	for (const file of files) {
		const text = readFileSync(join(appRoot, file), "utf8");
		for (const match of text.matchAll(LITERAL_BUDGET)) {
			const line = text.slice(0, match.index).split("\n").length;
			found.push(`${file}:${line} ${match[0].replace(/\s+/g, " ")}`);
		}
	}
	return found;
}

describe("test timeouts", () => {
	it("come from src/test/timeouts.ts, never a number in the test", () => {
		expect(literalBudgets()).toEqual([]);
	});

	it("recognises the shapes it refuses and the data it leaves alone", () => {
		const hits = (source: string) => [...source.matchAll(LITERAL_BUDGET)].length;
		expect(hits('it("x", { timeout: 15_000 }, () => {});')).toBe(1);
		expect(hits("await waitFor(() => check(), {\n\t\ttimeout: 3000,\n\t});")).toBe(1);
		expect(hits("errors: { types: { timeout: 2 } }")).toBe(0);
		expect(hits("{ url, timeout: 200_000 }")).toBe(0);
		expect(hits('it("x", { timeout: BUILD_TEST_TIMEOUT_MS }, fn)')).toBe(0);
	});
});
