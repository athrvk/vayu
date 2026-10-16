/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The percentile lines carry no verdict (#2245).
 *
 * `LatencyPercentilesChart` drew p50 green, p95 amber and p99 red whatever the
 * numbers were, so a 3 ms p99 read as failing. Which percentile a line is says
 * nothing about whether the run was slow - the SLO marker is what judges - and
 * red has to stay a signal for status. This guards the roles the three series
 * are declared with, and what those roles resolve to, so a repoint of
 * `ROLE_TOKEN` cannot walk them back into the status palette either.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ROLE_TOKEN, type ColorRole } from "./uplotTheme";

const here = dirname(fileURLToPath(import.meta.url));

/** The roles that read as a verdict: the generic trio and the HTTP status family. */
const STATUS_ROLES = new Set<string>([
	"success",
	"warning",
	"destructive",
	"status-success",
	"status-redirect",
	"status-client-error",
	"status-server-error",
	"status-no-response",
]);

const STATUS_TOKENS = new Set<string>(
	[...STATUS_ROLES].map((role) => ROLE_TOKEN[role as ColorRole])
);

const source = readFileSync(join(here, "TimeSeriesCharts.tsx"), "utf8")
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/\/\/.*$/gm, "");

/** `{ label: "p50", role: "muted", ... }` -> the role each percentile is declared with. */
const percentileRoles = [...source.matchAll(/label:\s*"(p\d+)",\s*role:\s*"([\w-]+)"/g)].map(
	(m) => ({ label: m[1], role: m[2] })
);

describe("percentile series colours", () => {
	it("finds the three series it is meant to be guarding", () => {
		// A scan that matches nothing passes silently and reads as coverage.
		expect(percentileRoles.map((s) => s.label)).toEqual(["p50", "p95", "p99"]);
	});

	it("declares none of them with a status role", () => {
		for (const { label, role } of percentileRoles) {
			expect(
				STATUS_ROLES.has(role),
				`${label} is declared with the status role ${role}`
			).toBe(false);
		}
	});

	it("resolves none of them to a status token", () => {
		for (const { label, role } of percentileRoles) {
			const token = ROLE_TOKEN[role as ColorRole];
			expect(token, `${label}: ${role} is not a ColorRole`).toBeDefined();
			expect(STATUS_TOKENS.has(token), `${label} resolves to ${token}`).toBe(false);
		}
	});

	it("gives each percentile a colour of its own", () => {
		const roles = percentileRoles.map((s) => s.role);
		expect(new Set(roles).size).toBe(roles.length);
	});
});
