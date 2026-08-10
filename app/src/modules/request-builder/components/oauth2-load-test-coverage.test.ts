/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { coverageState, fmtDuration, isMidRunRefreshable } from "./oauth2-load-test-coverage";

const NOW = 1_000_000_000_000;
// A token minted now, valid `lifetimeS` seconds, with `remainingS` left.
const token = (lifetimeS: number, remainingS: number, hasRefreshToken = true) => ({
	expiresIn: lifetimeS,
	expiresAt: NOW + remainingS * 1000,
	hasRefreshToken,
});

describe("coverageState", () => {
	it("is inert without a fixed duration (iterations mode)", () => {
		expect(coverageState(null, true, token(3600, 3600), false, NOW).kind).toBe("inert");
		expect(coverageState(0, true, token(3600, 3600), false, NOW).kind).toBe("inert");
	});

	it("reports no-config / no-token when it cannot decide", () => {
		expect(coverageState(60, false, undefined, false, NOW).kind).toBe("no-config");
		expect(coverageState(60, true, undefined, false, NOW).kind).toBe("no-token");
	});

	it("treats a non-expiring token as covered", () => {
		const s = coverageState(
			100_000,
			true,
			{ expiresIn: 0, expiresAt: null, hasRefreshToken: false },
			false,
			NOW
		);
		expect(s).toEqual({ kind: "covered", nonExpiring: true });
	});

	it("is covered when the remaining life exceeds the duration", () => {
		// 10-min test, token has 1h left → covered
		expect(coverageState(600, true, token(3600, 3600), false, NOW).kind).toBe("covered");
	});

	it("suggests refresh when a fresh token would cover but the cached one won't", () => {
		// 50-min test, token lifetime 1h but only 20m left → refresh clears it
		const s = coverageState(50 * 60, true, token(3600, 20 * 60), false, NOW);
		expect(s.kind).toBe("refresh");
		if (s.kind === "refresh") {
			expect(s.durationMs).toBe(50 * 60 * 1000);
			expect(s.lifetimeMs).toBe(3600 * 1000);
			expect(s.remainingMs).toBe(20 * 60 * 1000);
		}
	});

	it("flags too-long when even a fresh token cannot cover the test", () => {
		// 2h test, token lifetime only 1h → uncoverable
		const s = coverageState(2 * 3600, true, token(3600, 3600), false, NOW);
		expect(s.kind).toBe("too-long");
		if (s.kind === "too-long") {
			expect(s.lifetimeMs).toBe(3600 * 1000);
			expect(s.durationMs).toBe(2 * 3600 * 1000);
		}
	});

	it("boundary: duration exactly equal to remaining is covered", () => {
		expect(coverageState(3600, true, token(3600, 3600), false, NOW).kind).toBe("covered");
	});

	// The #478 branch: what used to gate the Start button is the engine's job
	// now. Both states that blocked a run become covered when it can renew.
	it("is covered when the engine renews the token mid-run", () => {
		const stale = coverageState(50 * 60, true, token(3600, 20 * 60), true, NOW);
		expect(stale).toEqual({
			kind: "covered",
			nonExpiring: false,
			remainingMs: 20 * 60 * 1000,
			viaRefresh: true,
		});

		const longer = coverageState(2 * 3600, true, token(3600, 3600), true, NOW);
		expect(longer.kind).toBe("covered");
		if (longer.kind === "covered") expect(longer.viaRefresh).toBe(true);
	});

	it("does not claim a refresh when the cached token covers the run anyway", () => {
		const s = coverageState(600, true, token(3600, 3600), true, NOW);
		expect(s.kind).toBe("covered");
		if (s.kind === "covered") expect(s.viaRefresh).toBeUndefined();
	});
});

// Mirrors plan_auth_refresh in the engine; a divergence here either promises a
// refresh that never happens or blocks a run the engine could have carried.
describe("isMidRunRefreshable", () => {
	const clientCredentials = { grantType: "client_credentials" } as const;

	it("renews a header-placed expiring token", () => {
		expect(isMidRunRefreshable(clientCredentials, token(3600, 600))).toBe(true);
	});

	it("cannot renew a query-placed token", () => {
		expect(
			isMidRunRefreshable({ ...clientCredentials, tokenPlacement: "query" }, token(3600, 600))
		).toBe(false);
		expect(
			isMidRunRefreshable(
				{ ...clientCredentials, tokenPlacement: "header" },
				token(3600, 600)
			)
		).toBe(true);
	});

	it("honours the autoRefreshToken opt-out", () => {
		expect(
			isMidRunRefreshable({ ...clientCredentials, autoRefreshToken: false }, token(3600, 600))
		).toBe(false);
		expect(
			isMidRunRefreshable({ ...clientCredentials, autoRefreshToken: true }, token(3600, 600))
		).toBe(true);
	});

	it("needs a refresh token for an authorization_code grant", () => {
		const authCode = { grantType: "authorization_code" } as const;
		expect(isMidRunRefreshable(authCode, token(3600, 600, false))).toBe(false);
		expect(isMidRunRefreshable(authCode, token(3600, 600, true))).toBe(true);
	});

	it("has nothing to renew without an expiring token", () => {
		expect(isMidRunRefreshable(clientCredentials, undefined)).toBe(false);
		expect(
			isMidRunRefreshable(clientCredentials, {
				expiresIn: 0,
				expiresAt: null,
				hasRefreshToken: true,
			})
		).toBe(false);
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
