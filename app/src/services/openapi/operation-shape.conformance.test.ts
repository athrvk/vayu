/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the renderer's path-shape reduction against the
 * shared fixture the engine's gtest suite (`engine/tests/operation_match_test.cpp`)
 * also drives.
 *
 * Since issue #761 the engine owns operation matching (`POST /specs/match`).
 * The renderer still reduces the same shapes for the spec diff and the export
 * skeleton, so one rule has two implementations until those move too - and this
 * is the rule that decides which request is which operation, where a
 * disagreement does not fail loudly but stamps the wrong identity. So parity is
 * a table of cases both suites read: a divergence fails here or in ctest rather
 * than reaching a user as a diff that reports an endpoint moved when it did not.
 *
 * Read from the engine tree on purpose (the same pattern as
 * `variable-resolution.conformance.test.ts`): one file, two readers, no copy to
 * drift. The fixture's `shape` column is engine-only - the renderer no longer
 * reduces a *request URL* to a shape, which was the matcher's job.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { operationShapeKey, specPathShape, splitRequestUrl } from "./operation-match";

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
	"operation-shape-conformance.json"
);

interface UrlCase {
	name: string;
	url: string;
	origin: string | null;
	path: string | null;
	shape: string | null;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	requestUrls: UrlCase[];
	specPaths: { path: string; shape: string }[];
	shapeKeys: { method: string; pathShape: string; key: string }[];
};

describe("operation shape conformance", () => {
	it("reads a table with cases in it", () => {
		// An empty fixture would pass every loop below while proving nothing -
		// the failure mode a source-scanning guard in this repo already had once.
		expect(fixture.requestUrls.length).toBeGreaterThan(0);
		expect(fixture.specPaths.length).toBeGreaterThan(0);
		expect(fixture.shapeKeys.length).toBeGreaterThan(0);
	});

	it.each(fixture.requestUrls)("splits $name", (one) => {
		const parts = splitRequestUrl(one.url);
		expect(parts.origin ?? null).toBe(one.origin);
		expect(parts.path ?? null).toBe(one.path);
	});

	it.each(fixture.specPaths)("reduces $path", ({ path, shape }) => {
		expect(specPathShape(path)).toBe(shape);
	});

	it.each(fixture.shapeKeys)("keys $method $pathShape", ({ method, pathShape, key }) => {
		expect(operationShapeKey(method, pathShape)).toBe(key);
	});
});
