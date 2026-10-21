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
 * Default `castNumbers` to true, ignore `quoted`, or drop the safe-integer
 * guard in `numeric-cell.ts`, and the `castNumbers` cases fail (#2540).
 * Remove the `exceedsNesting` loop from `assertRowObject` in `index.ts` and the
 * nesting cases fail (#2362).
 */

import { describe, it, expect } from "vitest";

import {
	DataFileError,
	detectDataFileFormat,
	parseDataFile,
	parseDelimited,
	resolveIterationCount,
	tokenizeDelimited,
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

	it("refuses text that ends inside a quoted value, naming the line it opened on", () => {
		// Without this the three intended rows become one cell holding all of
		// them, and a one-column file makes that invisible to the ragged check.
		expect(() => parseDelimited('name\n"alice\nbob\ncarol', ",")).toThrow(
			/ends inside a quoted value that starts on line 2/
		);
	});

	it("counts the opening line over physical lines, quoted newlines included", () => {
		expect(() => parseDelimited('a\n"one\ntwo"\n"unclosed', ",")).toThrow(/line 4/);
	});
});

describe("tokenizeDelimited", () => {
	it("reports the same cells as parseDelimited", () => {
		const text = 'a,b\n"x,y",z\r\n"",\n';
		expect(tokenizeDelimited(text, ",").cells).toEqual(parseDelimited(text, ","));
	});

	it("tells a quoted empty cell from an unquoted one", () => {
		const { cells, quoted } = tokenizeDelimited('a,b,c\n"",,x', ",");
		expect(cells[1]).toEqual(["", "", "x"]);
		expect(quoted[1]).toEqual([true, false, false]);
	});

	it("flags a quoted cell whose text looks like a number", () => {
		const { quoted } = tokenizeDelimited('id,n\n"007",007', ",");
		expect(quoted).toEqual([
			[false, false],
			[true, false],
		]);
	});

	it("keeps the flag through escaped quotes, embedded delimiters and newlines", () => {
		const { cells, quoted } = tokenizeDelimited('a,b,c\n"say ""hi""","x,y","l1\nl2"', ",");
		expect(cells[1]).toEqual(['say "hi"', "x,y", "l1\nl2"]);
		expect(quoted[1]).toEqual([true, true, true]);
	});

	it("does not flag a quote that appears mid-field", () => {
		const { cells, quoted } = tokenizeDelimited('a\n6" pipe', ",");
		expect(cells[1]).toEqual(['6" pipe']);
		expect(quoted[1]).toEqual([false]);
	});

	it("flags the cell by how it opened, not by how it closed", () => {
		const { quoted } = tokenizeDelimited('a\n"x"y', ",");
		expect(quoted[1]).toEqual([true]);
	});

	it("clears the flag between cells and rows, last row without a newline included", () => {
		const { quoted } = tokenizeDelimited('"a",b\nc,"d"', ",");
		expect(quoted).toEqual([
			[true, false],
			[false, true],
		]);
	});

	it("is the same grammar on tabs", () => {
		const { quoted } = tokenizeDelimited('a\tb\n"1"\t2', "\t");
		expect(quoted[1]).toEqual([true, false]);
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

describe("parseDataFile - castNumbers (#2540)", () => {
	const cast = { castNumbers: true };

	it("leaves every cell text by default, and echoes the setting", () => {
		const text = "a,b,c\n3,3.5,007";
		for (const parsed of [parseDataFile(text, "r.csv"), parseDataFile(text, "r.csv", {})]) {
			expect(parsed.rows).toEqual([{ a: "3", b: "3.5", c: "007" }]);
			expect(parsed.castNumbers).toBe(false);
		}
		const explicit = parseDataFile(text, "r.csv", { castNumbers: false });
		expect(explicit.rows).toEqual([{ a: "3", b: "3.5", c: "007" }]);
	});

	it("reads an unquoted integer or decimal as a number, leading zeros and sign included", () => {
		const parsed = parseDataFile("a,b,c,d,e,f\n3,3.5,-2,+4,007,1.50", "r.csv", cast);
		expect(parsed.rows).toEqual([{ a: 3, b: 3.5, c: -2, d: 4, e: 7, f: 1.5 }]);
		expect(parsed.castNumbers).toBe(true);
	});

	it("keeps a quoted cell as text however numeric it looks", () => {
		const parsed = parseDataFile('a,b\n"3",3', "r.csv", cast);
		expect(parsed.rows).toEqual([{ a: "3", b: 3 }]);
	});

	it("keeps everything that is not a plain integer or decimal as text", () => {
		// Each of these is a number to Newman and to Number(), and not to us.
		const cells = [
			"abc",
			"1e3",
			".5",
			"5.",
			"0x1F",
			"NaN",
			"Infinity",
			"-Infinity",
			"",
			" 5",
			"5 ",
			"1,5",
		];
		const header = cells.map((_, i) => `c${i}`).join(",");
		const row = cells.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",");
		const parsed = parseDataFile(`${header}\n${row}`, "r.csv", cast);
		expect(Object.values(parsed.rows[0])).toEqual(cells);
	});

	it("keeps an integer past the safe range as text, so a long id survives", () => {
		const parsed = parseDataFile(
			"id,edge,over\n12345678901234567890,9007199254740991,9007199254740992",
			"r.csv",
			cast
		);
		expect(parsed.rows).toEqual([
			{ id: "12345678901234567890", edge: 9007199254740991, over: "9007199254740992" },
		]);
	});

	it("keeps a decimal text when the number would not print back as its digits", () => {
		const parsed = parseDataFile(
			"a,b,c,d\n0.1000000000000000055511151231257827,12345678901234567890.5,0.0000001,0.10",
			"r.csv",
			cast
		);
		expect(parsed.rows).toEqual([
			{
				a: "0.1000000000000000055511151231257827",
				b: "12345678901234567890.5",
				c: "0.0000001",
				d: 0.1,
			},
		]);
	});

	it("does not turn -0 into a number that prints differently from its cell", () => {
		const parsed = parseDataFile("a,b\n-0,-0.0", "r.csv", cast);
		expect(Object.is(parsed.rows[0].a, 0)).toBe(true);
		expect(Object.is(parsed.rows[0].b, 0)).toBe(true);
	});

	it("casts TSV the same way", () => {
		const parsed = parseDataFile('a\tb\tc\n007\t"007"\tx', "r.tsv", cast);
		expect(parsed.format).toBe("tsv");
		expect(parsed.rows).toEqual([{ a: 7, b: "007", c: "x" }]);
	});

	it("casts a header-sniffed file with no extension too", () => {
		expect(parseDataFile("a,b\n1,2", undefined, cast).rows).toEqual([{ a: 1, b: 2 }]);
	});

	it("does not touch the header row", () => {
		const parsed = parseDataFile("1,2\n3,4", "r.csv", cast);
		expect(parsed.columns).toEqual(["1", "2"]);
		expect(parsed.rows).toEqual([{ "1": 3, "2": 4 }]);
	});

	it("is ignored by JSON and JSONL, which already carry types", () => {
		const json = parseDataFile('[{"id":"007","n":3}]', "r.json", cast);
		expect(json.rows).toEqual([{ id: "007", n: 3 }]);
		expect(json.castNumbers).toBe(false);
		const jsonl = parseDataFile('{"id":"007","n":3}', "r.jsonl", cast);
		expect(jsonl.rows).toEqual([{ id: "007", n: 3 }]);
		expect(jsonl.castNumbers).toBe(false);
	});

	it("keeps the preview note about reading values as text when off, naming Newman", () => {
		const note = parseDataFile("a\n1", "r.csv").warnings.find((w) =>
			w.includes("read as text")
		);
		expect(note).toBe(
			'Values are read as text - "007" stays "007". Newman reads unquoted numbers as numbers; turn on "Read numbers as numbers" for that, or use a JSON or JSONL file.'
		);
	});

	it("says numbers were read as numbers and quoted cells stay text when on", () => {
		const warnings = parseDataFile("a\n1", "r.csv", cast).warnings;
		expect(warnings).toContain(
			'Numbers are read as numbers - "007" becomes 7. A quoted value such as "007" stays text.'
		);
		expect(warnings.some((w) => w.includes("read as text"))).toBe(false);
	});

	it("states no value-reading note for JSON, which has nothing to explain", () => {
		const warnings = parseDataFile('[{"a":1}]', "r.json", cast).warnings;
		expect(warnings.some((w) => /read as/.test(w))).toBe(false);
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

	it("warns about a column some rows lack, naming how many", () => {
		// The union hides it: `email` previews as a full column, and without the
		// warning the run dies at the iteration that binds the row without it.
		const parsed = parseDataFile('[{"id":1,"email":"a@b.c"},{"id":2},{"id":3}]', "rows.json");
		expect(parsed.columns).toEqual(["id", "email"]);
		expect(
			parsed.warnings.some((w) =>
				/Column "email" is missing from 2 of 3 rows.*\{\{data\.email\}\}/.test(w)
			)
		).toBe(true);
	});

	it("warns per column in JSONL too, and summarises past the fifth", () => {
		// Neither row shares a column with the other, so all eight of the union's
		// columns are uneven - five named, the rest counted.
		const wide = JSON.stringify(Object.fromEntries("abcdefg".split("").map((k) => [k, 1])));
		const parsed = parseDataFile(`${wide}\n{"z":1}`, "rows.jsonl");
		const uneven = parsed.warnings.filter((w) => w.startsWith("Column "));
		expect(uneven).toHaveLength(5);
		expect(
			parsed.warnings.some((w) => w === "3 more columns are missing from some rows.")
		).toBe(true);
	});

	it("says nothing when every row carries every column", () => {
		const parsed = parseDataFile('[{"a":1},{"a":2}]', "rows.json");
		expect(parsed.warnings.some((w) => w.startsWith("Column "))).toBe(false);
	});

	it("points a .json file holding JSON Lines at the right extension", () => {
		expect(() => parseDataFile('{"a":1}\n{"a":2}', "rows.json")).toThrow(
			/looks like JSON Lines.*Rename it \.jsonl or \.ndjson/
		);
	});

	it("does not blame JSON Lines for JSON that is merely broken", () => {
		expect(() => parseDataFile('[{"a":1},', "rows.json")).toThrow(/not valid JSON/);
		expect(() => parseDataFile('[{"a":1},', "rows.json")).not.toThrow(/JSON Lines/);
	});
});

/** `depth` levels of array around a scalar: `nested(2)` is `[[1]]`. */
function nested(depth: number): string {
	return "[".repeat(depth) + "1" + "]".repeat(depth);
}

describe("parseDataFile - nested cells (#2362)", () => {
	it("refuses a JSON cell nested past 100 levels, naming the row and column", () => {
		const text = `[{"tag":1},{"tag":2},{"tag":3},{"tag":4},{"tag":5,"address":${nested(101)}}]`;
		const error = (() => {
			try {
				parseDataFile(text, "rows.json");
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(DataFileError);
		expect((error as Error).message).toBe(
			'Row 4, column "address" is nested more than 100 levels deep.'
		);
	});

	it("refuses a JSONL cell nested past 100 levels, naming the line and column", () => {
		const text = `{"a":1}\n\n{"a":{"b":${nested(100)}}}`;
		const error = (() => {
			try {
				parseDataFile(text, "rows.jsonl");
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(DataFileError);
		expect((error as Error).message).toBe(
			'Line 3, column "a" is nested more than 100 levels deep.'
		);
	});

	it("counts through objects as well as arrays", () => {
		const deep = '{"k":'.repeat(101) + "1" + "}".repeat(101);
		expect(() => parseDataFile(`[{"c":${deep}}]`, "rows.json")).toThrow(/column "c"/);
	});

	it("accepts a cell nested exactly 100 levels", () => {
		const json = parseDataFile(`[{"c":${nested(100)}}]`, "rows.json");
		expect(json.rows).toHaveLength(1);
		const jsonl = parseDataFile(`{"c":${nested(100)}}`, "rows.jsonl");
		expect(jsonl.rows).toHaveLength(1);
	});

	it("keeps shallow object and array cells with their value", () => {
		const text = '[{"id":1,"address":{"city":"Pune","geo":[18.5,73.8]},"tags":["a",["b"]]}]';
		expect(parseDataFile(text, "rows.json").rows).toEqual([
			{ id: 1, address: { city: "Pune", geo: [18.5, 73.8] }, tags: ["a", ["b"]] },
		]);
		expect(parseDataFile(text.slice(1, -1), "rows.jsonl").rows).toEqual([
			{ id: 1, address: { city: "Pune", geo: [18.5, 73.8] }, tags: ["a", ["b"]] },
		]);
	});

	it("refuses a 100000-level cell without overflowing the stack", () => {
		// A recursive walk dies here with a RangeError rather than a DataFileError.
		const text = `[{"c":${nested(100_000)}}]`;
		expect(() => parseDataFile(text, "rows.json")).toThrow(DataFileError);
		expect(() => parseDataFile(text, "rows.json")).toThrow(
			/column "c" is nested more than 100/
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
