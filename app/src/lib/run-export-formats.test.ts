/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's export-format registry against the engine's: the fixture
 * lists every format `RUN_EXPORT_FORMATS` can write (`run_export_formats_test.cpp`
 * asserts the C++ side), so a format added to one side only fails here or there.
 *
 * Mutation check: change a `mimeType` in `run-export-formats.ts`, or add a row
 * to the fixture alone, and the equality case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { RUN_EXPORT_FORMATS } from "./run-export-formats";

interface FixtureRow {
	id: string;
	mimeType: string;
	extension: string;
	copyable: boolean;
	mcp: boolean;
}

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.runExportFormats.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureRow[];

describe("run export format conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.length).toBeGreaterThan(0);
	});

	it("holds exactly the formats the engine writes", () => {
		const registry = RUN_EXPORT_FORMATS.map(({ id, mimeType, extension, copyable, mcp }) => ({
			id,
			mimeType,
			extension,
			copyable,
			mcp,
		}));
		expect(registry).toEqual(fixture);
	});

	it("labels every format and repeats none", () => {
		expect(RUN_EXPORT_FORMATS.every((format) => format.label.length > 0)).toBe(true);
		const ids = RUN_EXPORT_FORMATS.map((format) => format.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
