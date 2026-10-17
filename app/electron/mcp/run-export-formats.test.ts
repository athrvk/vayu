/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The MCP server's export-format list against the engine's. `electron/` cannot
 * import the renderer's registry, so `run-export-formats.ts` holds a copy, and
 * the ids the fixture marks `mcp` must be exactly that copy.
 *
 * Mutation check: add a row with `"mcp": true` to the fixture alone, or drop
 * `json` from `MCP_EXPORT_FORMAT_IDS`, and the set-equality case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { MCP_EXPORT_FORMAT_IDS, defaultMcpExportFormat } from "./run-export-formats";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.mcpRunExportFormats.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
	id: string;
	mcp: boolean;
}>;

describe("MCP run export format conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.length).toBeGreaterThan(0);
		expect(fixture.some((format) => format.mcp)).toBe(true);
	});

	it("offers exactly the formats the fixture marks for MCP", () => {
		const expected = fixture.filter((format) => format.mcp).map((format) => format.id);
		expect([...MCP_EXPORT_FORMAT_IDS].sort()).toEqual(expected.sort());
	});

	it("defaults to a format it offers", () => {
		expect(MCP_EXPORT_FORMAT_IDS).toContain(defaultMcpExportFormat);
	});
});
