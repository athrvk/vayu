/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: which lines a Headers table sends, against the
 * engine's `stored_header_rows` (`engine/src/http/request_composer.cpp`), over
 * the fixture both suites read (issue #2466).
 *
 * A table answered two ways is a Send that goes out one way and a stored
 * request composed by id that goes out another, so each case is replayed
 * through the renderer's `toHeaderRows` and, past it, the snippet generators'
 * intake, which must not reorder or drop what the table sent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { prepareRequest } from "@/services/codegen/prepare";
import { toHeaderRows } from "./key-value";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.headerRows.paths.map(fromRepoRoot);

interface HeaderRowsCase {
	name: string;
	rows: Array<{ key: string; value: string; enabled: boolean }>;
	expected: Array<{ name: string; value: string }>;
}

const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as HeaderRowsCase[];

describe("header rows conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		// An empty table would pass every case below.
		expect(cases.length).toBeGreaterThanOrEqual(6);
		expect(cases.some((c) => c.expected.length > 1)).toBe(true);
		// The case the issue is about: one name, three rows.
		const isDup = (line: { name: string }) => line.name.toLowerCase() === "x-dup";
		expect(cases.some((c) => c.expected.filter(isDup).length === 3)).toBe(true);
	});

	it.each(cases.map((c) => [c.name, c] as const))("toHeaderRows: %s", (_name, c) => {
		expect(toHeaderRows(c.rows)).toEqual(c.expected);
	});

	it.each(cases.map((c) => [c.name, c] as const))("a snippet keeps them: %s", (_name, c) => {
		const prepared = prepareRequest({
			method: "GET",
			url: "https://example.test/",
			headers: toHeaderRows(c.rows),
		});
		expect(prepared.headers).toEqual(c.expected.map(({ name, value }) => [name, value]));
	});
});
