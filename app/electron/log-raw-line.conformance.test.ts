/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The key a record carries its own line under is spelled four times (#3635):
 * `RAW_LINE_KEY` in `log-reader.ts`, which sets it; its copy in
 * `src/modules/logs/log-entry.ts`, which reads it (`src/` may not import from
 * `electron/`); and the property in the preload's entry shape and the
 * renderer's `LogFileRecord`, which are types and so are read as source. A
 * spelling changed on one side alone leaves Copy line and Export
 * re-serialising, and the table drawing the raw line as a field.
 *
 * Mutation check: rename the key in any one of the four and its case reds.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAW_LINE_KEY as rendererKey } from "@/modules/logs/log-entry";
import { RAW_LINE_KEY as readerKey } from "./log-reader";

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
