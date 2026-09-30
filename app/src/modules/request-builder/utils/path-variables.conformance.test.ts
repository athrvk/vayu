/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: this file's segment scanner and substitution
 * against the engine's (`engine/src/core/path_template.cpp`, which composes
 * the request), over the fixture both suites read.
 *
 * The app draws the Params tab's "Sends" line and the code snippets from its
 * own copy, so a case answered two ways is a request that shows one URL and
 * sends another. Adding a case to the fixture fails whichever side does not
 * handle it, the arrangement `parse-set-cookie.conformance.test.ts` uses.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { KeyValueEntry } from "@/types";
import { pathVariableSegments, substitutePathVariables } from "./path-variables";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.pathVariables.paths.map(fromRepoRoot);

interface ConformanceCase {
	name: string;
	url: string;
	rows: KeyValueEntry[];
	segments: { name: string; offset: number; length: number }[];
	composed: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: ConformanceCase[] };

describe("path variable conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.cases.length).toBeGreaterThan(20);
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		expect(pathVariableSegments(c.url)).toEqual(c.segments);
		expect(substitutePathVariables(c.url, c.rows)).toBe(c.composed);
	});
});
