/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the identity this app's import parsers stamp on a
 * request against the index the engine derives from the same document
 * (`engine/tests/openapi_document_test.cpp` reads the same table).
 *
 * Since issue #853 the engine reads the stored document and writes the
 * `operations` index itself, and since #869 nothing the app ships reads a
 * document to answer what it declares at all - `importedOperations` here is a
 * test-only walk of what the import pipeline builds. That removes the
 * duplication but not the *agreement* these two readers still owe each other:
 * coverage resolves a request's stamped `specOperation` against the engine's
 * index, by `operationId` first and `METHOD path` second
 * (`OperationIndex::resolve`). A disagreement fails nothing loudly - it credits
 * the wrong operation, or reports a request as exercising something the
 * document does not declare. So both readers are held to one table.
 *
 * Read from the engine tree on purpose, like
 * `operation-shape.conformance.test.ts` and
 * `variable-resolution.conformance.test.ts`: one file, two suites, no copy to
 * drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importedOperations } from "./imported-operations.testkit";
import type { SpecOperation } from "@/types";

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
	"declared-operations-conformance.json"
);

interface FixtureCase {
	name: string;
	document: string;
	operations: { operationId?: string; method: string; path: string; responses: string[] }[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: FixtureCase[] };

/**
 * Identity only, sorted.
 *
 * `responses` is the engine's half - nothing here reads it any more. And the
 * order is the engine's half too: it writes the index in document order, while
 * `importedOperations` walks the collection tree the parsers built (root
 * requests, then tag folders), so comparing sequences would fail on a document
 * both sides agree about.
 */
function identities(operations: SpecOperation[]): string[] {
	return operations
		.map((o) => `${o.operationId ?? ""} ${o.method} ${o.path}`)
		.sort((a, b) => a.localeCompare(b));
}

describe("declared-operation conformance", () => {
	it("has cases to check", () => {
		// A fixture that failed to load reads as a suite of passing tests.
		expect(fixture.cases.length).toBeGreaterThan(0);
	});

	for (const testCase of fixture.cases) {
		it(`stamps the identities the engine indexes: ${testCase.name}`, () => {
			const expected = testCase.operations.map((o) => ({
				...(o.operationId ? { operationId: o.operationId } : {}),
				method: o.method,
				path: o.path,
			}));
			expect(
				identities(importedOperations(testCase.document).map((e) => e.operation))
			).toEqual(identities(expected));
		});
	}
});
