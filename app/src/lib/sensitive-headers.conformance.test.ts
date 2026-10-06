/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's sensitive-header list against the engine's: both read
 * `sensitiveHeaderNames` in `engine/tests/fixtures/log-redaction-conformance.json`
 * (the C++ side asserts each is an `is_secret_field_name`), so a header added
 * to one list and not the other fails here or in `debug_redact_test.cpp`.
 *
 * Mutation check: drop `x-csrf-token` from `SENSITIVE_HEADER_NAMES` and the
 * list-equality case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { SENSITIVE_HEADER_NAMES, isSensitiveHeaderName } from "./sensitive-headers";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.sensitiveHeaders.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	sensitiveHeaderNames: string[];
};

describe("sensitive header conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.sensitiveHeaderNames.length).toBeGreaterThan(0);
	});

	it("holds exactly the engine's list", () => {
		expect([...SENSITIVE_HEADER_NAMES].sort()).toEqual(
			[...fixture.sensitiveHeaderNames].sort()
		);
	});
});

describe("isSensitiveHeaderName", () => {
	it.each(SENSITIVE_HEADER_NAMES)("matches %s in any case", (name) => {
		expect(isSensitiveHeaderName(name)).toBe(true);
		expect(isSensitiveHeaderName(name.toUpperCase())).toBe(true);
	});

	it("matches the header the request's API-key auth names, in any case", () => {
		expect(isSensitiveHeaderName("X-Tenant-Key")).toBe(false);
		expect(isSensitiveHeaderName("x-tenant-key", "X-Tenant-Key")).toBe(true);
	});

	it("passes other headers through, and never matches a blank name", () => {
		expect(isSensitiveHeaderName("Content-Type", "X-Tenant-Key")).toBe(false);
		expect(isSensitiveHeaderName("", "")).toBe(false);
		expect(isSensitiveHeaderName("  ", "  ")).toBe(false);
	});
});
