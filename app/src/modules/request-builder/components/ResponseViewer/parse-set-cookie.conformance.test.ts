/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: this parser against the engine's copy
 * (`engine/src/http/set_cookie.cpp`, behind `pm.response.cookies`), over the
 * fixture both suites read.
 *
 * The two parse the same `Set-Cookie` off the same response - one for the
 * Cookies tab, one for a script - so a case answered two ways is a user reading
 * one thing on screen and asserting another in a test. Adding a case here fails
 * whichever side does not handle it, the same arrangement
 * `variable-resolution.conformance.test.ts` uses for `{{variable}}` resolution.
 *
 * Read from the engine tree on purpose: one file, two readers, no copy to drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { parseSetCookie, type ParsedCookie } from "./parse-set-cookie";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.setCookie.paths.map(fromRepoRoot);

interface ConformanceCase {
	name: string;
	header: string;
	expected: ParsedCookie[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	cases: ConformanceCase[];
};

describe("set-cookie conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.cases.length).toBeGreaterThan(10);
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		expect(parseSetCookie(c.header)).toEqual(c.expected);
	});
});
