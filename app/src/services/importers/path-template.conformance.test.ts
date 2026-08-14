/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: path templates (issue #481 phase 2).
 *
 * The app *writes* the URLs the engine's mock server has to read back. An
 * OpenAPI import stores `{{baseUrl}}/pets/{{petId}}` because `normalizeVars`
 * rewrote `{petId}`; the mock turns that same URL back into the route it
 * serves. A rule the two sides answer differently is an imported request the
 * mock silently cannot route - invisible until a 404 nobody can explain.
 *
 * `templateCases` is the shared half, asserted here and in
 * `engine/tests/mock_server_routes_test.cpp`. `urlCases` is the engine's own
 * half - stripping scheme, host, query and fragment, and the `:param` spelling
 * that Postman writes and this parser never produces - so only the engine
 * asserts those. This suite still requires them to exist, so emptying the
 * fixture fails on both sides rather than passing vacuously on one.
 *
 * Read from the engine tree on purpose (same pattern as
 * `variable-resolution.conformance.test.ts`): one file, two readers, no copy to
 * drift.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeVars } from "./var-normalize";

interface TemplateCase {
	name: string;
	input: string;
	expected: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
	here,
	"..",
	"..",
	"..",
	"..",
	"engine",
	"tests",
	"fixtures",
	"path-template-conformance.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	templateCases: TemplateCase[];
	urlCases: TemplateCase[];
};

describe("path-template conformance with the engine's mock server", () => {
	// A fixture that read as an empty list would pass every case below while
	// checking nothing - the failure mode a source-scanning guard in this repo
	// shipped with for weeks.
	it("reads a fixture with cases in both sections", () => {
		expect(fixture.templateCases.length).toBeGreaterThanOrEqual(5);
		expect(fixture.urlCases.length).toBeGreaterThanOrEqual(5);
	});

	it.each(fixture.templateCases)("$name", ({ input, expected }) => {
		expect(normalizeVars(input, { pathTemplates: true })).toBe(expected);
	});
});
