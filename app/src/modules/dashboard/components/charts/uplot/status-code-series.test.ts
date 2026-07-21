/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No chart series may be painted with the user's accent.
 *
 * `--primary` (and `--chart-1`, which tracks it) changes hue with the selected
 * colour scheme, so a series using either can collide with a neighbouring one.
 * Measured as OKLab distance against the semantic colours, the accent sits:
 *
 *     Coral   0.037 from --destructive
 *     Forest  0.050 from --success
 *     Ocean   0.057 from --info / --status-running
 *     Sunset  0.075 from --status-error   (the default theme)
 *     Sky     0.086 from --info
 *
 * Anything below roughly 0.10 reads as the same colour. In the stacked
 * status-code chart that meant 2xx and 3xx rendering identically on Forest, and
 * 3xx and 5xx on Coral — and there, colour is the entire encoding.
 *
 * This guards the roles, not the pixels: it reads the series specs and asserts
 * none of them resolves to an accent-tracking token, and that no two share a
 * role.
 *
 * **Scope widened after this guard missed four.** It originally read only
 * `StatusCodesOverTimeChart.tsx`, so the same defect sat untouched in the
 * scatter, HDR, latency and throughput charts until a parallel audit found it.
 * A guard written around the one instance you happened to find will keep the
 * rest — it now reads every chart spec in this directory.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Tokens whose value follows the user's chosen accent. */
const ACCENT_TRACKING = ["--primary", "--primary-fill", "--chart-1"];

function read(file: string): string {
	return readFileSync(join(here, file), "utf8");
}

/** Every module in this directory that declares chart series. */
const CHART_FILES = [
	"StatusCodesOverTimeChart.tsx",
	"TimeSeriesCharts.tsx",
	"ScatterAndDistribution.tsx",
];

describe("chart series colours", () => {
	const source = CHART_FILES.map(read).join("\n");

	// `role: "x"` and `bandRole: "x"`, ignoring anything inside a comment.
	const roles = [
		...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\b(?:band)?[Rr]ole:\s*"([a-z]+)"/g),
	].map((m) => m[1]);

	it("finds the series it is meant to be guarding", () => {
		// A guard that matches nothing passes silently and reads as coverage.
		expect(roles.length).toBeGreaterThanOrEqual(8);
	});

	it("paints no series with the accent", () => {
		expect(roles).not.toContain("primary");
		expect(roles).not.toContain("accent");
	});

	/**
	 * Uniqueness is checked only for the stacked status chart, deliberately.
	 *
	 * There, every series shares one plot, so two on the same role render alike —
	 * which is the bug this file was written for. The other two modules each
	 * declare *several* charts, and roles legitimately repeat across them:
	 * `success` is p50 in the latency plot and "achieved" in the rate plot, and
	 * they are never on screen together. A regex cannot tell which series share a
	 * plot, so asserting uniqueness per file reports those as collisions.
	 *
	 * The accent ban above is what covers those modules, and it is the part that
	 * matters — it is what four series were violating.
	 */
	it("gives each series in the stacked status chart its own role", () => {
		const lineRoles = [
			...read("StatusCodesOverTimeChart.tsx")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.matchAll(/label:\s*"(\w+)",\s*\n?\s*role:\s*"(\w+)"/g),
		].map((m) => m[2]);
		expect(lineRoles.length).toBeGreaterThanOrEqual(4);
		expect(new Set(lineRoles).size).toBe(lineRoles.length);
	});

	it("resolves the categorical role to a token that does not follow the accent", () => {
		const theme = read("uplotTheme.ts");
		const mapped = theme.match(/categorical:\s*"(--[a-z0-9-]+)"/);
		expect(mapped).not.toBeNull();
		expect(ACCENT_TRACKING).not.toContain(mapped?.[1]);
	});
});
