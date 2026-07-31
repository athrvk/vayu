/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the renderer's *preview* resolution
 * (`lib/variable-resolution.ts`) against the shared fixture that the engine's
 * gtest suite (`engine/tests/request_composer_test.cpp`) also drives.
 *
 * Since issue #226 the engine owns execution-time resolution (`POST
 * /compose`); the renderer's copy only previews. The old parity guard
 * compared two TypeScript copies - useless once one side is C++ - so parity
 * is now a table of `(scopes, input, expected)` cases both suites read. A
 * divergence fails here or in ctest rather than reaching a user as a preview
 * that lies about what will be sent.
 *
 * Read from the engine tree on purpose (same pattern as
 * `design-system-doc.test.ts` reading `docs/`): one file, two readers, no
 * copy to drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildVariableValues,
	resolveTemplate,
	type StoredVariableBag,
} from "./variable-resolution";
import { DYNAMIC_VARIABLES } from "./dynamic-variables";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
	here,
	"..",
	"..",
	"..",
	"engine",
	"tests",
	"fixtures",
	"variable-resolution-conformance.json"
);

interface ConformanceCase {
	name: string;
	scopes: {
		globals?: StoredVariableBag;
		chain?: StoredVariableBag[];
		environment?: StoredVariableBag;
	};
	input: string;
	expected: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	dynamicVariableNames: string[];
	cases: ConformanceCase[];
};

describe("variable-resolution conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.cases.length).toBeGreaterThan(10);
		expect(fixture.dynamicVariableNames.length).toBeGreaterThan(0);
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const values = buildVariableValues(c.scopes);
		expect(resolveTemplate(c.input, (name) => values.get(name))).toBe(c.expected);
	});

	it("the dynamic-variable table lists exactly the fixture's names", () => {
		// The engine asserts the same list against its C++ table, so a generator
		// added on one side without the other fails one of the two suites.
		expect(DYNAMIC_VARIABLES.map((v) => v.name)).toEqual(fixture.dynamicVariableNames);
	});
});
