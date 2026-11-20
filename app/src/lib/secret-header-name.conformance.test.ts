/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `isSecretHeaderName` against the engine's logger set: every name in the
 * fixture's `secretFieldNames` is masked, in any case, except the
 * `challengeHeaderNames`, which a record shows, and `notSecretFieldNames` pass
 * through. The engine test asserts the logger still masks the challenge names.
 *
 * Mutation check: drop `session_token` from `SECRET_HEADER_NAMES` and its case
 * reds; add `www-authenticate` and the challenge case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { isSecretHeaderName } from "./secret-header-name";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.secretHeaderNames.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	secretFieldNames: string[];
	notSecretFieldNames: string[];
	challengeHeaderNames: string[];
};

const credentialNames = fixture.secretFieldNames.filter(
	(name) => !fixture.challengeHeaderNames.includes(name.toLowerCase())
);

describe("secret header name conformance", () => {
	it("read a non-empty fixture", () => {
		expect(credentialNames.length).toBeGreaterThan(0);
		expect(fixture.challengeHeaderNames.length).toBeGreaterThan(0);
		expect(fixture.notSecretFieldNames.length).toBeGreaterThan(0);
	});

	it.each(credentialNames)("masks %s in any case", (name) => {
		expect(isSecretHeaderName(name)).toBe(true);
		expect(isSecretHeaderName(name.toUpperCase())).toBe(true);
	});

	it.each(fixture.challengeHeaderNames)("shows the challenge header %s", (name) => {
		expect(fixture.secretFieldNames).toContain(name);
		expect(isSecretHeaderName(name)).toBe(false);
		expect(isSecretHeaderName(name.toUpperCase())).toBe(false);
	});

	it.each(fixture.notSecretFieldNames)("passes %s through", (name) => {
		expect(isSecretHeaderName(name)).toBe(false);
	});

	it("folds ASCII only, as the engine does", () => {
		// The Kelvin sign lowercases to `k` under toLowerCase; the engine does not fold it.
		expect(isSecretHeaderName("K")).toBe(false);
		expect(isSecretHeaderName("x-api-Key")).toBe(false);
	});
});
