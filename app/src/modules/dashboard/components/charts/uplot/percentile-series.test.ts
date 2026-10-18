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
 *
 * The HDR distribution's vertical markers followed the same rule (#2263): they
 * take warning / destructive only for a value past the SLO.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunReport } from "@/types";
import { ROLE_TOKEN, type ColorRole } from "./uplotTheme";
import { hdrPercentileMarkers, pctToX } from "./hdrMarkers";

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

// The chart builds its three series from `PERCENTILE_LEGEND` (the legend renders
// the same entries), so that table is where the roles are declared.
const source =
	readFileSync(join(here, "legend.ts"), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.match(/PERCENTILE_LEGEND = \{[\s\S]*?\} as const/)?.[0] ?? "";

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

const latency = (p: { p50: number; p95: number; p99: number }) =>
	p as unknown as RunReport["latency"];

const roleOf = (markers: ReturnType<typeof hdrPercentileMarkers>, label: string) =>
	markers.find((m) => m.label === label)?.role;

describe("HDR percentile markers", () => {
	const healthy = latency({ p50: 1, p95: 2, p99: 3 });

	it("draws the three vertical markers at their percentile's x", () => {
		const markers = hdrPercentileMarkers(healthy, 100);
		expect(markers.map((m) => m.label)).toEqual(["p50", "p95", "p99"]);
		expect(markers.map((m) => m.value)).toEqual([pctToX(50), pctToX(95), pctToX(99)]);
		expect(markers.every((m) => m.orient === "vertical")).toBe(true);
	});

	it("takes no status role while every value is within the SLO", () => {
		const markers = hdrPercentileMarkers(healthy, 100);
		for (const { label, role } of markers) {
			expect(STATUS_ROLES.has(role), `${label} is ${role} under the SLO`).toBe(false);
			expect(STATUS_TOKENS.has(ROLE_TOKEN[role]), `${label} resolves to a status token`).toBe(
				false
			);
		}
	});

	it("takes no status role when no SLO is known", () => {
		for (const { label, role } of hdrPercentileMarkers(healthy)) {
			expect(STATUS_ROLES.has(role), `${label} is ${role} with no SLO`).toBe(false);
		}
	});

	it("keeps a value equal to the SLO neutral, as the latency tiles do", () => {
		expect(roleOf(hdrPercentileMarkers(healthy, 3), "p99")).toBe("categorical");
	});

	it("turns p95 warning and p99 destructive once each is past the SLO", () => {
		const markers = hdrPercentileMarkers(latency({ p50: 1, p95: 20, p99: 30 }), 10);
		expect(roleOf(markers, "p50")).toBe("muted");
		expect(roleOf(markers, "p95")).toBe("warning");
		expect(roleOf(markers, "p99")).toBe("destructive");
	});

	it("judges each marker by its own value", () => {
		const markers = hdrPercentileMarkers(latency({ p50: 1, p95: 5, p99: 30 }), 10);
		expect(roleOf(markers, "p95")).toBe("categorical-2");
		expect(roleOf(markers, "p99")).toBe("destructive");
	});

	it("never judges p50, however slow", () => {
		expect(
			roleOf(hdrPercentileMarkers(latency({ p50: 500, p95: 600, p99: 700 }), 10), "p50")
		).toBe("muted");
	});

	it("draws nothing without a latency block and skips an absent percentile", () => {
		expect(hdrPercentileMarkers(undefined, 10)).toEqual([]);
		const partial = { p50: 1, p99: 3 } as unknown as RunReport["latency"];
		expect(hdrPercentileMarkers(partial, 10).map((m) => m.label)).toEqual(["p50", "p99"]);
	});
});
