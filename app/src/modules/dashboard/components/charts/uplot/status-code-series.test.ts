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

describe("status-code chart series", () => {
	const source = read("StatusCodesOverTimeChart.tsx");

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

	it("gives each status class its own role, so no two can render alike", () => {
		const lineRoles = [
			...source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.matchAll(/label:\s*"(\w+)",\s*\n?\s*role:\s*"(\w+)"/g),
		].map((m) => m[2]);
		expect(new Set(lineRoles).size).toBe(lineRoles.length);
	});

	it("resolves the categorical role to a token that does not follow the accent", () => {
		const theme = read("uplotTheme.ts");
		const mapped = theme.match(/categorical:\s*"(--[a-z0-9-]+)"/);
		expect(mapped).not.toBeNull();
		expect(ACCENT_TRACKING).not.toContain(mapped?.[1]);
	});
});
