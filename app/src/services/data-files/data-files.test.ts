/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data-file parser (issue #402). Node env - nothing here touches a DOM.
 *
 * The grammar cases are the ones that separate a real RFC 4180 tokenizer from
 * a `split(",")`: quoted delimiters, embedded newlines, doubled quotes, CRLF.
 * Revert the quote handling in `tabular.ts` and the first four of them fail.
 */

import { describe, it, expect } from "vitest";

import {
	DataFileError,
	detectDataFileFormat,
	parseDataFile,
	parseDelimited,
	resolveIterationCount,
} from "./index";

describe("parseDelimited", () => {
	it("keeps a delimiter that sits inside a quoted field", () => {
		expect(parseDelimited('a,b\n"x,y",z', ",")).toEqual([
			["a", "b"],
			["x,y", "z"],
		]);
	});

	it("keeps a newline that sits inside a quoted field", () => {
		expect(parseDelimited('a,b\n"line1\nline2",z', ",")).toEqual([
			["a", "b"],
			["line1\nline2", "z"],
		]);
	});

	it("reads a doubled quote as one literal quote", () => {
		expect(parseDelimited('a\n"say ""hi"""', ",")).toEqual([["a"], ['say "hi"']]);
	});

	it("treats a quote that does not open a field as a literal character", () => {
		// A spreadsheet exporting a value with an inch mark writes exactly this.
		expect(parseDelimited('a\n6" pipe', ",")).toEqual([["a"], ['6" pipe']]);
	});

	it("consumes CRLF as one row break", () => {
		expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("emits the last row without a trailing newline, and no phantom row with one", () => {
		expect(parseDelimited("a\n1", ",")).toEqual([["a"], ["1"]]);
		expect(parseDelimited("a\n1\n", ",")).toEqual([["a"], ["1"]]);
	});

	it("keeps an empty trailing cell", () => {
		expect(parseDelimited("a,b\n1,", ",")).toEqual([
			["a", "b"],
			["1", ""],
		]);
	});

	it("is the same grammar on tabs", () => {
		expect(parseDelimited('a\tb\n"x\ty"\tz', "\t")).toEqual([
			["a", "b"],
			["x\ty", "z"],
		]);
	});
});

describe("detectDataFileFormat", () => {
	it("takes the extension when there is a known one", () => {
		expect(detectDataFileFormat("a,b\n1,2", "rows.csv")).toBe("csv");
		expect(detectDataFileFormat("a,b\n1,2", "rows.TSV")).toBe("tsv");
		expect(detectDataFileFormat("{}", "rows.ndjson")).toBe("jsonl");
	});

	it("sniffs when the name says nothing", () => {
		expect(detectDataFileFormat('[{"a":1}]')).toBe("json");
		expect(detectDataFileFormat('{"a":1}\n{"a":2}')).toBe("jsonl");
		expect(detectDataFileFormat("a\tb\n1\t2")).toBe("tsv");
		expect(detectDataFileFormat("a,b\n1,2")).toBe("csv");
	});

	it("prefers the extension over a sniff that would disagree", () => {
		// A .csv whose first cell happens to start with a brace is still a CSV.
		expect(detectDataFileFormat("{a},b\n1,2", "rows.csv")).toBe("csv");
	});
});

describe("parseDataFile - CSV and TSV", () => {
	it("maps the header row onto every row, as strings", () => {
		const parsed = parseDataFile("user,id\nada,007\ngrace,42", "rows.csv");
		expect(parsed.format).toBe("csv");
		expect(parsed.columns).toEqual(["user", "id"]);
		// Strings always: `007` surviving is the reason, and it is JMeter/k6
		// behaviour rather than a shortcut.
		expect(parsed.rows).toEqual([
			{ user: "ada", id: "007" },
			{ user: "grace", id: "42" },
		]);
	});

	it("reads a TSV through the same grammar", () => {
		const parsed = parseDataFile("user\tid\nada\t007", "rows.tsv");
		expect(parsed.format).toBe("tsv");
		expect(parsed.rows).toEqual([{ user: "ada", id: "007" }]);
	});

	it("strips a UTF-8 BOM rather than naming the first column \\ufeffuser", () => {
		const parsed = parseDataFile("﻿user,id\nada,1", "rows.csv");
		expect(parsed.columns).toEqual(["user", "id"]);
	});

	it("skips blank lines and says how many", () => {
		const parsed = parseDataFile("user\nada\n\ngrace\n", "rows.csv");
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.warnings.some((w) => w.includes("Skipped 1 blank line"))).toBe(true);
	});

	it("states the strings-only asymmetry in a warning", () => {
		const parsed = parseDataFile("user\nada", "rows.csv");
		expect(parsed.warnings.some((w) => w.includes("read as text"))).toBe(true);
	});

	it("refuses a ragged row, naming it and both counts", () => {
		expect(() => parseDataFile("user,id\nada,1\ngrace", "rows.csv")).toThrow(
			/Row 2 has 1 value but the header names 2 columns/
		);
		expect(() => parseDataFile("user,id\nada,1,extra", "rows.csv")).toThrow(
			/Row 1 has 3 values/
		);
	});

	it("refuses an unnamed header column", () => {
		expect(() => parseDataFile("user,,id\na,b,c", "rows.csv")).toThrow(
			/Column 2 of the header row has no name/
		);
	});

	it("refuses a duplicated header column", () => {
		// Unaddressable rather than merely untidy: `{{data.user}}` could mean
		// either one, so there is no correct row to build.
		expect(() => parseDataFile("user,user\na,b", "rows.csv")).toThrow(/names "user" twice/);
	});

	it("refuses a file with a header and no rows", () => {
		expect(() => parseDataFile("user,id\n", "rows.csv")).toThrow(/no data rows/);
	});

	it("refuses an empty file", () => {
		expect(() => parseDataFile("", "rows.csv")).toThrow(DataFileError);
	});
});

describe("parseDataFile - JSON and JSONL", () => {
	it("keeps native JSON types", () => {
		const parsed = parseDataFile('[{"id":7,"ok":true,"note":null}]', "rows.json");
		expect(parsed.rows).toEqual([{ id: 7, ok: true, note: null }]);
		expect(parsed.columns).toEqual(["id", "ok", "note"]);
	});

	it("unions columns in first-seen order across rows", () => {
		const parsed = parseDataFile('[{"a":1},{"b":2},{"a":3}]', "rows.json");
		expect(parsed.columns).toEqual(["a", "b"]);
	});

	it("refuses a JSON file that is not an array", () => {
		expect(() => parseDataFile('{"a":1}', "rows.json")).toThrow(
			/must be an array of row objects/
		);
	});

	it("refuses a non-object element, naming its index", () => {
		expect(() => parseDataFile('[{"a":1},"nope"]', "rows.json")).toThrow(
			/Row 1 is string, not an object/
		);
	});

	it("reads one object per line", () => {
		const parsed = parseDataFile('{"a":1}\n{"a":2}\n', "rows.jsonl");
		expect(parsed.rows).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("names the line when a JSONL line will not parse", () => {
		// The line number is the whole value of the error here - "invalid JSON"
		// about a 500-line file is unactionable.
		expect(() => parseDataFile('{"a":1}\nnot json\n{"a":3}', "rows.jsonl")).toThrow(/Line 2/);
	});

	it("names the line when a JSONL line is not an object", () => {
		expect(() => parseDataFile('{"a":1}\n[1,2]', "rows.jsonl")).toThrow(
			/Line 2 is an array, not an object/
		);
	});
});

describe("resolveIterationCount", () => {
	it("defaults to the row count", () => {
		expect(resolveIterationCount(500, undefined)).toBe(500);
	});

	it("lets an explicit count win, including one below the row count", () => {
		// The case the pre-run summary exists for: 500 rows, 1 iteration.
		expect(resolveIterationCount(500, 1)).toBe(1);
		expect(resolveIterationCount(2, 5)).toBe(5);
	});

	it("is 1 when there are no rows at all", () => {
		expect(resolveIterationCount(0, undefined)).toBe(1);
	});
});
