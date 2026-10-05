/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the editor token layer finds a time (issue #1786). What the card says
 * is `describeInstant`'s business (`time-value.test.ts`); this pins which
 * spans reach it, per language, and that near misses never do.
 */

import { describe, it, expect } from "vitest";
import {
	TIME_TOKEN_MATCHERS,
	codeTimeTokenRanges,
	proseTimeTokenRanges,
	type TimeTokenRange,
} from "./monaco-time-tokens";

function model(...lines: string[]) {
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
	};
}

/** What a reader checks: the text found and the columns it was found at. */
function spans(ranges: TimeTokenRange[]) {
	return ranges.map((r) => [r.text, r.lineNumber, r.startColumn, r.endColumn]);
}

describe("TIME_TOKEN_MATCHERS", () => {
	it("covers every language CodeEditor is handed a body or a script in", () => {
		expect(Object.keys(TIME_TOKEN_MATCHERS).sort()).toEqual(
			["graphql", "html", "javascript", "json", "plaintext", "xml", "yaml"].sort()
		);
	});

	it.each(["json", "javascript", "graphql"])("reads %s as code", (language) => {
		expect(TIME_TOKEN_MATCHERS[language]).toBe(codeTimeTokenRanges);
	});

	it.each(["plaintext", "yaml", "xml", "html"])("reads %s as prose", (language) => {
		expect(TIME_TOKEN_MATCHERS[language]).toBe(proseTimeTokenRanges);
	});
});

describe("codeTimeTokenRanges", () => {
	it("covers a string literal's inner text, not its quotes", () => {
		// `"` is column 8, so the time starts at 9 and ends one past `Z`.
		expect(spans(codeTimeTokenRanges(model('{"at": "2026-10-05T07:23:00Z"}')))).toEqual([
			["2026-10-05T07:23:00Z", 1, 9, 29],
		]);
	});

	it("finds all three quotes and an HTTP date", () => {
		const ranges = codeTimeTokenRanges(
			model(
				"const a = '2026-10-05';",
				'const b = "Sun, 05 Oct 2026 07:23:00 GMT";',
				"const c = `2026-10-05T07:23:00+05:30`;"
			)
		);
		expect(ranges.map((r) => [r.text, r.parsed.form])).toEqual([
			["2026-10-05", "iso"],
			["Sun, 05 Oct 2026 07:23:00 GMT", "http-date"],
			["2026-10-05T07:23:00+05:30", "iso"],
		]);
		expect(ranges[0].startColumn).toBe(12);
	});

	it("finds a bare epoch number in seconds and in milliseconds", () => {
		const ranges = codeTimeTokenRanges(model('{"s": 1759648980, "ms": 1759648980123}'));
		expect(ranges.map((r) => [r.text, r.parsed.form, r.startColumn])).toEqual([
			["1759648980", "epoch-seconds", 7],
			["1759648980123", "epoch-milliseconds", 25],
		]);
	});

	it("leaves a literal that only mentions a time, and a template with a substitution", () => {
		expect(codeTimeTokenRanges(model('"deadline 2026-10-05"', "`${base}2026-10-05`"))).toEqual(
			[]
		);
	});

	it("tells a time apart from a near miss", () => {
		expect(
			codeTimeTokenRanges(
				model(
					'{"version": "2026.10.05", "id": 20261005, "big": 1759648980123456}',
					'{"neg": -1759648980, "dec": 1759648980.5, "low": "0000000042"}'
				)
			)
		).toEqual([]);
	});

	it("stops at the line cap", () => {
		const lines = Array.from({ length: 6000 }, () => '"2026-10-05"');
		expect(codeTimeTokenRanges(model(...lines))).toHaveLength(5000);
	});
});

describe("proseTimeTokenRanges", () => {
	it("finds an unquoted YAML value, and a quoted one, by its inner text", () => {
		expect(
			spans(proseTimeTokenRanges(model("expires: 2026-10-05 08:10:00", "at: '1759648980'")))
		).toEqual([
			["2026-10-05 08:10:00", 1, 10, 29],
			["1759648980", 2, 6, 16],
		]);
	});

	it("finds an element's text and an attribute value in XML or HTML", () => {
		expect(
			proseTimeTokenRanges(
				model('<ts zone="x">2026-10-05T08:10:00+05:30</ts><a at="1759648980123"/>')
			).map((r) => r.text)
		).toEqual(["2026-10-05T08:10:00+05:30", "1759648980123"]);
	});

	it("is not thrown by an apostrophe in plain text", () => {
		expect(
			proseTimeTokenRanges(
				model("it's 2026-10-05T08:00:00Z, don't. Date: Sun, 05 Oct 2026 07:23:00 GMT")
			).map((r) => r.text)
		).toEqual(["2026-10-05T08:00:00Z", "Sun, 05 Oct 2026 07:23:00 GMT"]);
	});

	it("tells a time apart from a near miss", () => {
		expect(
			proseTimeTokenRanges(
				model(
					"version: 2026.10.05",
					"id: 20261005",
					"big: 1759648980123456",
					"range: 2026-10-05-10",
					"bad: 2026-02-31"
				)
			)
		).toEqual([]);
	});
});
