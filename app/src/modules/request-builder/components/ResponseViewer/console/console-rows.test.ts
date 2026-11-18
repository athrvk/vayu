/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the Console puts a script request (#3633): in its summary line's place
 * when a line indexes it, otherwise after the last row its own script wrote.
 *
 * Mutation check: return `line` unconditionally in `consoleRows`' map and the
 * "in the line's place" case fails; insert every unlinked record at the end of
 * its source and the per-level case fails.
 */

import { describe, expect, it } from "vitest";

import type { ScriptRequestRecord } from "@/types";
import {
	consoleRowCount,
	consoleRows,
	isScriptRequestRow,
	rowMatches,
	type ConsoleRow,
} from "./console-rows";
import type { ParsedLog } from "./parse-logs";

const record = (overrides: Partial<ScriptRequestRecord> = {}): ScriptRequestRecord => ({
	source: "pre",
	status: 200,
	statusText: "OK",
	request: { method: "GET", url: "https://auth.example.test/token" },
	...overrides,
});

const line = (overrides: Partial<ParsedLog> = {}): ParsedLog => ({
	source: "pre",
	level: "log",
	message: "a line",
	...overrides,
});

/** Each row as a short label, so an order reads in one assertion. */
const labels = (rows: ConsoleRow[]) =>
	rows.map((row) =>
		isScriptRequestRow(row)
			? `request:${row.record.request.url}${row.line ? "+line" : ""}`
			: row.message
	);

describe("consoleRows", () => {
	it("hands the lines back unchanged when no script sent a request", () => {
		const lines = [line({ message: "one" }), line({ message: "two" })];
		expect(consoleRows(lines, undefined)).toEqual(lines);
		expect(consoleRows(lines, [])).toEqual(lines);
	});

	it("draws a linked record in its summary line's place", () => {
		const rows = consoleRows(
			[
				line({ message: "before" }),
				line({ level: "info", message: "pm.sendRequest ...", scriptRequest: 0 }),
				line({ message: "after" }),
			],
			[record({ request: { method: "POST", url: "u0" } })]
		);
		expect(labels(rows)).toEqual(["before", "request:u0+line", "after"]);
	});

	it("puts an unlinked record after the last line of its own source", () => {
		const rows = consoleRows(
			[
				line({ message: "pre one" }),
				line({ message: "pre two" }),
				line({ source: "test", message: "test one" }),
			],
			[record({ request: { url: "u0" } })]
		);
		expect(labels(rows)).toEqual(["pre one", "pre two", "request:u0", "test one"]);
	});

	it("puts an unlinked record after its own level's lines, before a later level's", () => {
		// The collection script ran before the request's own: its call belongs
		// between the two even when the console cap dropped its summary line.
		const rows = consoleRows(
			[
				line({ scope: "collection", message: "collection line" }),
				line({ scope: "request", message: "request line" }),
			],
			[record({ scope: "collection", request: { url: "u0" } })]
		);
		expect(labels(rows)).toEqual(["collection line", "request:u0", "request line"]);
	});

	it("keeps the records' own order when none has a line", () => {
		const rows = consoleRows(
			[],
			[
				record({ request: { url: "u0" } }),
				record({ request: { url: "u1" } }),
				record({ source: "test", request: { url: "u2" } }),
			]
		);
		expect(labels(rows)).toEqual(["request:u0", "request:u1", "request:u2"]);
		expect(rows.map((row) => row.source)).toEqual(["pre", "pre", "test"]);
	});

	it("draws a line whose index names no record, or a taken one, as the plain line", () => {
		const rows = consoleRows(
			[
				line({ message: "first", scriptRequest: 0 }),
				line({ message: "second", scriptRequest: 0 }),
				line({ message: "stray", scriptRequest: 9 }),
			],
			[record({ request: { url: "u0" } })]
		);
		expect(labels(rows)).toEqual(["request:u0+line", "second", "stray"]);
	});
});

describe("consoleRowCount", () => {
	it("counts a linked record once and an unlinked one on its own", () => {
		expect(
			consoleRowCount(
				[
					{ source: "pre", level: "info", message: "summary", scriptRequest: 0 },
					{ source: "pre", level: "log", message: "plain" },
				],
				[record(), record()]
			)
		).toBe(3);
	});
});

describe("rowMatches", () => {
	const row = consoleRows(
		[],
		[
			record({
				status: 0,
				request: { method: "POST", url: "https://auth.example.test/token" },
				error_type: "CONNECTION_FAILED",
			}),
		]
	)[0];

	it.each(["post", "auth.example", "0", "connection_failed"])(
		"finds a request by %s",
		(needle) => {
			expect(rowMatches(row, needle)).toBe(true);
		}
	);

	it("leaves a request out when nothing it shows matches", () => {
		expect(rowMatches(row, "unrelated")).toBe(false);
	});

	it("still matches a plain line by its text", () => {
		expect(rowMatches(line({ message: "token refreshed" }), "refreshed")).toBe(true);
	});
});
