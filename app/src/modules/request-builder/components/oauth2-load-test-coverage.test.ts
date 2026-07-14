/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { coverageState, fmtDuration } from "./oauth2-load-test-coverage";

const NOW = 1_000_000_000_000;
// A token minted now, valid `lifetimeS` seconds, with `remainingS` left.
const token = (lifetimeS: number, remainingS: number) => ({
	expiresIn: lifetimeS,
	expiresAt: NOW + remainingS * 1000,
});

describe("coverageState", () => {
	it("is inert without a fixed duration (iterations mode)", () => {
		expect(coverageState(null, true, token(3600, 3600), NOW).kind).toBe("inert");
		expect(coverageState(0, true, token(3600, 3600), NOW).kind).toBe("inert");
	});

	it("reports no-config / no-token when it cannot decide", () => {
		expect(coverageState(60, false, undefined, NOW).kind).toBe("no-config");
		expect(coverageState(60, true, undefined, NOW).kind).toBe("no-token");
	});

	it("treats a non-expiring token as covered", () => {
		const s = coverageState(100_000, true, { expiresIn: 0, expiresAt: null }, NOW);
		expect(s).toEqual({ kind: "covered", nonExpiring: true });
	});

	it("is covered when the remaining life exceeds the duration", () => {
		// 10-min test, token has 1h left → covered
		expect(coverageState(600, true, token(3600, 3600), NOW).kind).toBe("covered");
	});

	it("suggests refresh when a fresh token would cover but the cached one won't", () => {
		// 50-min test, token lifetime 1h but only 20m left → refresh clears it
		const s = coverageState(50 * 60, true, token(3600, 20 * 60), NOW);
		expect(s.kind).toBe("refresh");
		if (s.kind === "refresh") {
			expect(s.durationMs).toBe(50 * 60 * 1000);
			expect(s.lifetimeMs).toBe(3600 * 1000);
			expect(s.remainingMs).toBe(20 * 60 * 1000);
		}
	});

	it("flags too-long when even a fresh token cannot cover the test", () => {
		// 2h test, token lifetime only 1h → uncoverable
		const s = coverageState(2 * 3600, true, token(3600, 3600), NOW);
		expect(s.kind).toBe("too-long");
		if (s.kind === "too-long") {
			expect(s.lifetimeMs).toBe(3600 * 1000);
			expect(s.durationMs).toBe(2 * 3600 * 1000);
		}
	});

	it("boundary: duration exactly equal to remaining is covered", () => {
		expect(coverageState(3600, true, token(3600, 3600), NOW).kind).toBe("covered");
	});
});

describe("fmtDuration", () => {
	it("formats seconds/minutes/hours/days", () => {
		expect(fmtDuration(45_000)).toBe("45s");
		expect(fmtDuration(90_000)).toBe("2m");
		expect(fmtDuration(3 * 3600_000)).toBe("3h");
		expect(fmtDuration(3 * 24 * 3600_000)).toBe("3d");
	});
});
