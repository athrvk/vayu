/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The keys the reader attaches to a line are each spelled four times: the
 * raw line's (`RAW_LINE_KEY`, #3635) and the line's position's
 * (`POSITION_KEY`, #3652). Each is a constant in `log-reader.ts`, which sets
 * it; its copy in `src/modules/logs/log-entry.ts`, which reads it (`src/` may
 * not import from `electron/`); and a property in the preload's entry shape
 * and the renderer's entry types, which are types and so are read as source.
 * A spelling changed on one side alone leaves Copy line and Export
 * re-serialising, the table drawing the key as a field, or the renderer
 * reading no position.
 *
 * Mutation check: rename either key in any one of its four places and its
 * case reds.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	POSITION_KEY as rendererPositionKey,
	RAW_LINE_KEY as rendererKey,
} from "@/modules/logs/log-entry";
import { POSITION_KEY as readerPositionKey, RAW_LINE_KEY as readerKey } from "./log-reader";

/** The source of @p file from @p opening to the first @p closing after it. */
function declaration(file: string, opening: string, closing: string): string {
	const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
	const start = source.indexOf(opening);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf(closing, start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("the raw line's key", () => {
	it("is the reader's own in the renderer", () => {
		expect(readerKey).toBe("$raw");
		expect(rendererKey).toBe(readerKey);
	});

	it.each([
		["electron/preload.ts", "type LogEntryShape =", "| { unparsed: true"],
		["src/types/electron.d.ts", "export interface LogFileRecord {", "\n}"],
	])("is the record's optional string property in %s", (file, opening, closing) => {
		const block = declaration(file, opening, closing);
		expect(block).toContain("msg: string;");
		expect(block).toContain(`\t${readerKey}?: string;`);
	});
});

describe("the line position's key", () => {
	it("is the reader's own in the renderer", () => {
		expect(readerPositionKey).toBe("$pos");
		expect(rendererPositionKey).toBe(readerPositionKey);
	});

	it.each([
		[
			"electron/preload.ts",
			"type LogEntryShape =",
			"| { unparsed: true",
			"LogLinePositionShape",
		],
		["src/types/electron.d.ts", "export interface LogFileRecord {", "\n}", "LogLinePosition"],
	])("is the record's optional position property in %s", (file, opening, closing, type) => {
		const block = declaration(file, opening, closing);
		expect(block).toContain("msg: string;");
		expect(block).toContain(`\t${readerPositionKey}?: ${type};`);
	});

	it.each([
		["electron/preload.ts", "| { unparsed: true", "\n", "LogLinePositionShape }"],
		[
			"src/types/electron.d.ts",
			"export interface UnparsedLogLine {",
			"\n}",
			"LogLinePosition;",
		],
	])(
		"is the unparsed line's optional position property in %s",
		(file, opening, closing, type) => {
			const block = declaration(file, opening, closing);
			expect(block).toContain("raw: string;");
			expect(block).toContain(`${readerPositionKey}?: ${type}`);
		}
	);
});
