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
import {
	RUN_EXPORT_FORMATS,
	runExportActions,
	type RunExportFormatEntry,
} from "./run-export-formats";

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

	it("names every format and repeats none", () => {
		expect(RUN_EXPORT_FORMATS.every((format) => format.name.length > 0)).toBe(true);
		const ids = RUN_EXPORT_FORMATS.map((format) => format.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

/*
 * No format is copyable yet, so the copy half of the builder is held here on a
 * stubbed table. Mutation check: drop the `copyable` filter and the JSON row
 * gains a copy action; drop the copy half and Markdown loses its own.
 */
describe("runExportActions", () => {
	const markdown = {
		...RUN_EXPORT_FORMATS[0],
		id: "markdown",
		name: "Markdown",
		copyable: true,
	} as unknown as RunExportFormatEntry;

	it("offers a save per format, then a copy per copyable format", () => {
		const actions = runExportActions([RUN_EXPORT_FORMATS[0], markdown]);
		expect(actions.map(({ id, delivery, label }) => ({ id, delivery, label }))).toEqual([
			{ id: "save-json", delivery: "save", label: "Save as JSON" },
			{ id: "save-markdown", delivery: "save", label: "Save as Markdown" },
			{ id: "copy-markdown", delivery: "copy", label: "Copy as Markdown" },
		]);
	});

	it("offers only Save as JSON from today's table", () => {
		expect(runExportActions().map((action) => action.label)).toEqual(["Save as JSON"]);
	});
});
