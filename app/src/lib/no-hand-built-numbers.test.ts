/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `.toFixed(` in a component is a number's digits decided where it is drawn
 * (#2318): the same 4.2 seconds read "4.2s" on one card and "4.20s" on the
 * next, a percent grew one decimal in one table and two in another, and a
 * count of 10000 never got its separator. The digits come from
 * `lib/format-number.ts` (`formatNumber`, `formatLatency`, `formatSeconds`,
 * `formatRate`, `formatPercent`); a file may call `toFixed` only when it is on
 * the list below with the reason it is not one of those.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripComments } from "./strip-comments.testkit";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return sources(full);
		return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
	});
}

const TO_FIXED = /\.toFixed\(/;

/** Paths relative to `src/`, each with why its `toFixed` is not a display number to route. */
const ALLOWED: Record<string, string> = {
	"lib/run-compare.ts":
		"run-compare's duration text is pinned by the MCP conformance contract, shared with electron/mcp/compare.ts",
	"components/shared/response-viewer/utils.ts":
		"the response viewer's byte formatter (formatSize), spaced units by design",
	"modules/dashboard/utils/detectAnomalies.ts": "the `Nx baseline` multiplier is not a percent",
	"modules/dashboard/utils/detectAnomalies.testkit.ts":
		"the testkit twin of the `Nx baseline` multiplier",
	"modules/settings/utils/format-size.ts": "byte sizes, not latency, rate or percent",
	"modules/settings/main/panels/WorkspaceBackupCard.tsx":
		"byte sizes, not latency, rate or percent",
};

const files = sources(srcRoot).map((f) => ({
	rel: path.relative(srcRoot, f).split(path.sep).join("/"),
	code: stripComments(readFileSync(f, "utf8")),
}));

describe("no component builds a number's digits with toFixed", () => {
	it("scanned a non-empty tree", () => {
		expect(files.length).toBeGreaterThan(500);
	});

	it("finds toFixed only in the files that list a reason", () => {
		const offenders = files
			.filter((f) => TO_FIXED.test(f.code) && !(f.rel in ALLOWED))
			.map((f) => f.rel);
		expect(offenders).toEqual([]);
	});

	it("lists no file that has stopped calling toFixed", () => {
		const byPath = new Map(files.map((f) => [f.rel, f.code]));
		const stale = Object.keys(ALLOWED).filter((rel) => {
			const code = byPath.get(rel);
			return code === undefined || !TO_FIXED.test(code);
		});
		expect(stale).toEqual([]);
	});

	it("would catch the calls it exists for", () => {
		expect(TO_FIXED.test("{rate.toFixed(1)}%")).toBe(true);
		expect(TO_FIXED.test("`${trace?.totalMs?.toFixed(1)}ms`")).toBe(true);
		expect(TO_FIXED.test("formatPercent(rate)")).toBe(false);
	});
});
