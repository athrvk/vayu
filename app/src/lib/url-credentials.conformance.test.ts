/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `maskUrlCredentials` against the engine's `redact_url_credentials` names:
 * every name in the fixture's `sensitiveParamNames` (the set the engine's
 * query redaction blanks) is masked in a query and in a fragment, in any case,
 * and the two names the fixture says it leaves out on purpose pass through.
 *
 * Mutation check: drop a name from `SENSITIVE_PARAM_NAMES` and its case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { maskUrlCredentials } from "./url-credentials";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.urlCredentials.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	sensitiveParamNames: string[];
};

describe("url credential conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.sensitiveParamNames.length).toBeGreaterThan(0);
	});

	it.each(fixture.sensitiveParamNames)("masks %s in the query and the fragment", (name) => {
		expect(maskUrlCredentials(`https://h/p?${name}=S&page=2`)).toBe(
			`https://h/p?${name}=<redacted>&page=2`
		);
		expect(maskUrlCredentials(`https://h/cb#${name.toUpperCase()}=S`)).toBe(
			`https://h/cb#${name.toUpperCase()}=<redacted>`
		);
	});

	it.each(["code", "key"])("leaves %s as written, as the engine does", (name) => {
		expect(fixture.sensitiveParamNames).not.toContain(name);
		expect(maskUrlCredentials(`https://h/p?${name}=V`)).toBe(`https://h/p?${name}=V`);
	});
});
