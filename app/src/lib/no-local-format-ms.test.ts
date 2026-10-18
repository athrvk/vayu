/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A local `formatMs` is a second reading of a latency (#2276): CapacitySummary
 * rounded to one decimal, TransactionsSummary appended its own "ms", and the
 * announcer had a third rule, so one value read three ways and none of them
 * moved to seconds. A local `formatSeconds` is the same defect for a clock
 * (#2318): the anomaly labels rounded to a tenth beside a latency that printed
 * two decimals. `lib/format-number.ts` is the only place a duration's digits are
 * decided.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripComments } from "./strip-comments.testkit";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedHome = path.join(srcRoot, "lib", "format-number.ts");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sources(full);
		return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
	});
}

const LOCAL_FORMAT_DURATION =
	/\b(?:function\s+(?:formatMs|formatSeconds)\b|(?:const|let|var)\s+(?:formatMs|formatSeconds)\b)/;

describe("no module declares its own formatMs or formatSeconds", () => {
	const files = sources(srcRoot).filter((f) => f !== sharedHome);

	it("scanned a non-empty tree", () => {
		expect(files.length).toBeGreaterThan(100);
		const home = readFileSync(sharedHome, "utf8");
		expect(home).toMatch(/export\s+function\s+formatMs\b/);
		expect(home).toMatch(/export\s+function\s+formatSeconds\b/);
	});

	it("finds a declaration only in lib/format-number.ts", () => {
		const offenders = files.filter((f) =>
			LOCAL_FORMAT_DURATION.test(stripComments(readFileSync(f, "utf8")))
		);
		expect(offenders.map((f) => path.relative(srcRoot, f))).toEqual([]);
	});

	it("would catch the declarations it exists for", () => {
		expect(LOCAL_FORMAT_DURATION.test("function  formatMs(ms: number) {}")).toBe(true);
		expect(LOCAL_FORMAT_DURATION.test("const formatMs = (ms: number) => ms;")).toBe(true);
		expect(LOCAL_FORMAT_DURATION.test("function formatSeconds(s: number) {}")).toBe(true);
		expect(LOCAL_FORMAT_DURATION.test("const formatSeconds = (s: number) => s;")).toBe(true);
		expect(LOCAL_FORMAT_DURATION.test("import { formatMs } from '@/lib/format-number';")).toBe(
			false
		);
		expect(
			LOCAL_FORMAT_DURATION.test("import { formatSeconds } from '@/lib/format-number';")
		).toBe(false);
	});
});
