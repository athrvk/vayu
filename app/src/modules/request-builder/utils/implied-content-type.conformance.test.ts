/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the Content-Type each body mode implies, as the
 * engine's `implied_content_type` answers it (`engine/tests/implied_content_type_test.cpp`)
 * against the three copies the app holds - the code generators' table, the
 * header row the Body panel writes, and the type chip the panel shows
 * (issue #2464).
 *
 * A mode answered two ways is a snippet or a chip describing a request the
 * engine does not send.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { IMPLIED_CONTENT_TYPE } from "@/services/codegen/prepare";
import { BODY_MODES } from "../components/RequestTabs/panels/body/body-modes";
import { requiredContentType } from "../components/RequestTabs/panels/body/content-type";
import type { BodyMode } from "../types";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.impliedContentType.paths.map(fromRepoRoot);

interface ModeRow {
	name: string;
	mode: BodyMode;
	expected: string;
	panelWritesRow: boolean;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { modes: ModeRow[] };
const rows = fixture.modes;
const byMode = (mode: BodyMode): ModeRow | undefined => rows.find((row) => row.mode === mode);

/**
 * The modes the code generators take their header from `IMPLIED_CONTENT_TYPE`
 * for. `form-data` and `x-www-form-urlencoded` are written as `-F` /
 * `--data-urlencode` and the client writes the header itself, and `binary`
 * answers per file in `binaryContentType` (declared type, else octet-stream),
 * so none of the three is a row of that table by design.
 */
const CODEGEN_TABLE_MODES: readonly BodyMode[] = ["json", "graphql", "jsonrpc", "xml", "text"];

describe("implied Content-Type conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(rows.length).toBeGreaterThanOrEqual(9);
		expect(rows.some((row) => row.expected !== "")).toBe(true);
	});

	it("names every body mode the picker offers, and only those", () => {
		expect(rows.map((row) => row.mode).sort()).toEqual(BODY_MODES.map((m) => m.value).sort());
	});

	describe("the code generators' table", () => {
		it.each(rows.map((row) => [row.mode, row] as const))("%s", (_mode, row) => {
			if (!CODEGEN_TABLE_MODES.includes(row.mode)) {
				expect(IMPLIED_CONTENT_TYPE[row.mode]).toBeUndefined();
				return;
			}
			expect(IMPLIED_CONTENT_TYPE[row.mode]).toBe(row.expected);
		});

		it("holds no mode the fixture does not have", () => {
			expect(Object.keys(IMPLIED_CONTENT_TYPE).sort()).toEqual(
				[...CODEGEN_TABLE_MODES].sort()
			);
		});
	});

	describe("the header row the Body panel writes", () => {
		it.each(rows.map((row) => [row.mode, row] as const))("%s", (_mode, row) => {
			expect(requiredContentType(row.mode)).toBe(row.panelWritesRow ? row.expected : null);
		});

		it("writes a row only for a mode that has a type to write", () => {
			for (const row of rows.filter((r) => r.panelWritesRow)) {
				expect(row.expected, row.name).not.toBe("");
			}
		});
	});

	describe("the type chip beside the mode picker", () => {
		it.each(BODY_MODES.map((m) => [m.value, m] as const))("%s", (mode, option) => {
			const row = byMode(mode);
			expect(row, `fixture has no row for ${mode}`).toBeDefined();
			if (!row) return;

			// `none` sends nothing and `binary` answers per file, so no one type
			// can be named; the chip is null for both.
			if (mode === "none" || mode === "binary") {
				expect(option.contentType).toBeNull();
				return;
			}
			// libcurl writes a form-data header with its boundary, so the fixture
			// holds "" and the chip names the bare type.
			if (mode === "form-data") {
				expect(option.contentType).toBe("multipart/form-data");
				return;
			}
			expect(option.contentType).toBe(row.expected);
		});
	});
});
