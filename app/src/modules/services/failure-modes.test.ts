/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The summary line is written by a table that covers every failure mode, so a
 * mode the engine gains is read here from the labels table rather than from a
 * hand-kept list that would forget it too.
 */

import { describe, expect, it } from "vitest";
import type { MockIssuer, MockIssuerFailureMode } from "@/types";
import { FAILURE_MODE_LABELS, failureModeSummary } from "./failure-modes";

function issuer(overrides: Partial<MockIssuer> = {}): MockIssuer {
	return {
		issuerId: "iss_a",
		issuerUrl: "http://127.0.0.1:42000",
		tokenUrl: "http://127.0.0.1:42000/token",
		authorizeUrl: "http://127.0.0.1:42000/authorize",
		metadataUrl: "http://127.0.0.1:42000/.well-known/oauth-authorization-server",
		discoverUrl: "http://127.0.0.1:42000/resource",
		signingKey: "k".repeat(32),
		port: 42000,
		expiresInSeconds: 3600,
		failureMode: "none",
		slowMs: 2000,
		issueRefreshTokens: false,
		resourceScope: "",
		clientCount: 0,
		createdAt: 1700000000000,
		...overrides,
	};
}

const MODES = Object.keys(FAILURE_MODE_LABELS) as MockIssuerFailureMode[];
const FAULTY_MODES = MODES.filter((mode) => mode !== "none");

describe("failureModeSummary", () => {
	it("scans a non-empty table of modes, the healthy one among them", () => {
		expect(MODES).toContain("none");
		expect(FAULTY_MODES.length).toBeGreaterThan(0);
	});

	it("says nothing about failure for a healthy issuer", () => {
		expect(failureModeSummary(issuer())).toBe(
			"Tokens expire in 3600s · any client id accepted."
		);
	});

	it.each(FAULTY_MODES)("names what %s does, apart from the healthy summary", (mode) => {
		const healthy = failureModeSummary(issuer());
		const summary = failureModeSummary(issuer({ failureMode: mode }));
		expect(summary).not.toBe(healthy);
		expect(summary).toMatch(/^Tokens expire in 3600s · .+ · any client id accepted\.$/);
	});

	it("gives every failure mode a clause of its own", () => {
		const clauses = FAULTY_MODES.map((mode) =>
			failureModeSummary(issuer({ failureMode: mode }))
		);
		expect(new Set(clauses).size).toBe(FAULTY_MODES.length);
	});

	it("reports the delay only for slow", () => {
		expect(failureModeSummary(issuer({ failureMode: "slow", slowMs: 750 }))).toContain(
			"answers after 750ms"
		);
		expect(failureModeSummary(issuer({ failureMode: "wrong_iss", slowMs: 750 }))).not.toContain(
			"750"
		);
	});

	it("reports a resource scope when one is required, and none otherwise", () => {
		expect(failureModeSummary(issuer({ resourceScope: "mcp:read mcp:write" }))).toContain(
			"resource requires scope mcp:read mcp:write"
		);
		expect(failureModeSummary(issuer())).not.toContain("scope");
	});
});
