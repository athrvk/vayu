/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The line position the reader attaches (#3652) is not a field: the table's
 * text, the opened row's JSON, Copy line and Export leave it out, and the byte
 * estimate counts it. `firstAtOrAfter` is where a jump's time falls among lines.
 *
 * Mutation checks: drop `POSITION_KEY` from `READER_KEYS` and the hiding cases
 * draw, show and export it; count an unparsed line as its raw text alone in
 * `entryBytes` and the unparsed estimate case reds; compare with `>` in
 * `firstAtOrAfter` and the exact-time case lands a line late.
 */

import { describe, expect, it } from "vitest";
import type { LogFileRecord, LogLinePosition, UnparsedLogLine } from "@/types/electron";
import {
	POSITION_KEY,
	RAW_LINE_KEY,
	entryBytes,
	entryLine,
	exportLine,
	firstAtOrAfter,
	fieldsText,
	recordJson,
} from "./log-entry";

const position: LogLinePosition = {
	name: "engine_20261118_100000.log",
	id: "2049:131",
	start: 1024,
	end: 1180,
};

const fields = {
	ts: "2026-11-18T10:00:00.000Z",
	level: "info",
	src: "engine",
	cat: "http",
	msg: "Request answered",
	pid: 4242,
	status: 200,
} as const;

const record: LogFileRecord = { ...fields, [POSITION_KEY]: position };

describe("the line position", () => {
	it("is not one of the record's fields in the table's text", () => {
		expect(fieldsText(record)).toBe("status=200");
	});

	it("is left out of the opened row's JSON", () => {
		expect(JSON.parse(recordJson(record))).toEqual(fields);
	});

	it("is left out of a record re-serialised for Copy line and Export", () => {
		expect(JSON.parse(entryLine(record))).toEqual(fields);
		const cut: LogFileRecord = {
			...record,
			[RAW_LINE_KEY]: '{"ts":"2026-11-18T10:00:00.000Z"',
		};
		expect(JSON.parse(exportLine(cut))).toEqual(fields);
	});

	it("is not in the raw line Copy line writes", () => {
		const raw = JSON.stringify(fields);
		expect(entryLine({ ...record, [RAW_LINE_KEY]: raw })).toBe(raw);
	});
});

describe("entryBytes", () => {
	it("counts a record's position, which it serialises with the record", () => {
		expect(entryBytes(record)).toBe(2 * JSON.stringify(record).length);
		expect(entryBytes(record)).toBeGreaterThan(2 * JSON.stringify(fields).length);
	});

	it("counts an unparsed line as its raw text and its position", () => {
		const line: UnparsedLogLine = { unparsed: true, raw: "SEGFAULT", [POSITION_KEY]: position };
		expect(entryBytes(line)).toBe(2 * ("SEGFAULT".length + JSON.stringify(position).length));
		expect(entryBytes({ unparsed: true, raw: "SEGFAULT" })).toBe(2 * "SEGFAULT".length);
	});
});

describe("firstAtOrAfter", () => {
	const at = (second: number): LogFileRecord => ({
		...fields,
		ts: `2026-11-18T10:00:0${second}.000Z`,
	});
	const unparsed: UnparsedLogLine = { unparsed: true, raw: "SEGFAULT" };

	it("is the first line timed at the instant or after it", () => {
		const lines = [at(1), at(3), at(5)];

		expect(firstAtOrAfter(lines, "2026-11-18T10:00:03.000Z")).toBe(1);
		expect(firstAtOrAfter(lines, "2026-11-18T10:00:03.001Z")).toBe(2);
		expect(firstAtOrAfter(lines, "2026-11-18T09:00:00.000Z")).toBe(0);
	});

	it("is the length when no line is, and for no lines", () => {
		expect(firstAtOrAfter([at(1), at(3)], "2026-11-18T10:00:04.000Z")).toBe(2);
		expect(firstAtOrAfter([], "2026-11-18T10:00:04.000Z")).toBe(0);
	});

	it("passes a line with no time, which is neither before nor after", () => {
		expect(firstAtOrAfter([at(1), unparsed, at(5)], "2026-11-18T10:00:03.000Z")).toBe(2);
		expect(firstAtOrAfter([unparsed], "2026-11-18T10:00:03.000Z")).toBe(1);
	});
});
