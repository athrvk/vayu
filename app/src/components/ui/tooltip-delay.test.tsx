/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One tooltip delay, and only the root sets it.
 *
 * `TIMING.TOOLTIP_DELAY_MS` documented itself as "used across the app" and
 * reached almost none of it: `main.tsx` mounted a bare `<TooltipProvider>`, so
 * Radix's 700ms default governed nearly every tooltip, while two components set
 * 150ms locally.
 *
 * The quiet part is that a *bare* nested provider is not a no-op. Radix's
 * `delayDuration` defaults to `DEFAULT_DELAY_DURATION = 700` on every provider,
 * so a nested one with no prop **re-establishes 700ms for its subtree** rather
 * than inheriting. `Dock` and `CollectionTree` each had one, which is why
 * setting the root alone would not have reached them.
 *
 * Two things are guarded, because fixing one without the other does nothing:
 *
 *   1. The root passes the constant.
 *   2. No component mounts a nested provider that would shadow it.
 *
 * The second is a source scan, so it asserts it scanned something first - a
 * scan that reads nothing passes every assertion after it, which has happened
 * in this repo before.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TIMING } from "@/config/timing";

const SRC = resolve(__dirname, "..", "..");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (/\.tsx$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** Components, not test harnesses - a test may mount its own provider freely. */
const componentFiles = walk(SRC).filter((f) => !/\.test\.tsx$/.test(f));

const MAIN = join(SRC, "main.tsx");

describe("the scan itself", () => {
	it("found component files to search", () => {
		expect(componentFiles.length).toBeGreaterThan(100);
		expect(componentFiles).toContain(MAIN);
	});
});

describe("the root provider", () => {
	const main = readFileSync(MAIN, "utf8");

	it("passes the shared delay rather than taking Radix's default", () => {
		expect(main).toMatch(/<TooltipProvider\s+delayDuration=\{TIMING\.TOOLTIP_DELAY_MS\}>/);
	});

	it("uses a delay that is actually faster than the default it replaced", () => {
		// A constant that drifted up to 700 would make the whole exercise a no-op
		// while every assertion above still passed.
		expect(TIMING.TOOLTIP_DELAY_MS).toBeGreaterThan(0);
		expect(TIMING.TOOLTIP_DELAY_MS).toBeLessThan(700);
	});
});

describe("nested providers", () => {
	it("exist nowhere but the root, since a bare one re-establishes 700ms", () => {
		const offenders = componentFiles.filter(
			(f) => f !== MAIN && readFileSync(f, "utf8").includes("<TooltipProvider")
		);
		expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
	});
});
