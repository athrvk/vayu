/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The params bulk editor dropped two kinds of line in silence, and the panel
 * wrote the result over the user's params either way.
 *
 * The old parser was `/^([^=]+)=\s*(.*)$/` - `=` or nothing:
 *
 *   - `Authorization: Bearer abc` has no `=`, so pasting a header block by
 *     mistake returned `[]`, and every param the user had was replaced by
 *     nothing. No error, no warning, same failure the Headers tab already had
 *     fixed for itself.
 *   - `page` matched nothing either, although `?page` is a legal valueless
 *     parameter and `buildUrlWithParams` already emits exactly that.
 *
 * **Why params and headers cannot share one separator**, which is the question
 * that turned these up: a param *name* may legally contain a colon
 * (`filter:status=open` - JIRA, Elasticsearch, OData), a header name may not.
 * So headers split at whichever of `:` or `=` comes first, while params must
 * let `=` win wherever it is and consult `:` only when there is no `=` at all.
 * The shared rule is one level up - see `kv-line.ts`.
 */

import { describe, it, expect } from "vitest";
import { formatParamsToText, parseParamsFromText, isNoOpParamsEdit } from "./params-format";
import type { KeyValueItem } from "@/types";

const pairs = (text: string) => parseParamsFromText(text).map(({ key, value }) => ({ key, value }));

const items = (...kv: Array<[string, string]>): KeyValueItem[] =>
	kv.map(([key, value], i) => ({ id: `id-${i}`, key, value, enabled: true }));

describe("the format the panel tells the user to write", () => {
	it("parses the placeholder's own example", () => {
		// Verbatim from the ParamsPanel textarea placeholder.
		expect(pairs("page=1\nlimit=10\nsort=name")).toEqual([
			{ key: "page", value: "1" },
			{ key: "limit", value: "10" },
			{ key: "sort", value: "name" },
		]);
	});

	it("round-trips without drift", () => {
		const original = items(["page", "1"], ["q", "hello world"]);
		expect(pairs(formatParamsToText(original))).toEqual([
			{ key: "page", value: "1" },
			{ key: "q", value: "hello world" },
		]);
	});
});

describe("a param name may contain a colon", () => {
	it("splits at the equals, not the colon", () => {
		// The line that proves params and headers cannot share a rule. Under the
		// headers rule (first of either) this becomes `filter` / `status=open`.
		expect(pairs("filter:status=open")).toEqual([{ key: "filter:status", value: "open" }]);
	});

	it("keeps a colon inside a value attached to it", () => {
		expect(pairs("redirect=https://example.com/cb")).toEqual([
			{ key: "redirect", value: "https://example.com/cb" },
		]);
	});

	it("keeps a time value intact", () => {
		expect(pairs("from=12:30")).toEqual([{ key: "from", value: "12:30" }]);
	});
});

describe("a header block pasted here", () => {
	it("parses instead of vanishing", () => {
		// The whole failure: no `=` anywhere, so the old parser returned [] and
		// the panel wrote that over the user's params.
		expect(pairs("Authorization: Bearer abc\nAccept: application/json")).toEqual([
			{ key: "Authorization", value: "Bearer abc" },
			{ key: "Accept", value: "application/json" },
		]);
	});

	it("still prefers the equals when a line has both", () => {
		expect(pairs("X-Origin=https://example.com:8443")).toEqual([
			{ key: "X-Origin", value: "https://example.com:8443" },
		]);
	});
});

describe("a valueless parameter", () => {
	it("survives a round trip", () => {
		// `?page` is legal, and `buildUrlWithParams` already emits it - so losing
		// it here was the editor disagreeing with the thing that sends it.
		expect(pairs("page")).toEqual([{ key: "page", value: "" }]);
	});

	it("writes back as a bare key, not `page=`", () => {
		expect(formatParamsToText(items(["page", ""]))).toBe("page");
	});

	it("does not turn a valued param into a bare one", () => {
		expect(formatParamsToText(items(["page", "2"]))).toBe("page=2");
	});
});

describe("lines that name nothing", () => {
	it.each([
		["a leading equals", "=orphaned"],
		["a leading colon", ": orphaned"],
		["whitespace before the separator", "   = orphaned"],
	])("drops %s", (_label, line) => {
		// An empty key is a row the user can neither identify nor fix.
		expect(pairs(line)).toEqual([]);
	});

	it("drops blank lines without dropping the rest", () => {
		expect(pairs("page=1\n\n   \nlimit=10")).toEqual([
			{ key: "page", value: "1" },
			{ key: "limit", value: "10" },
		]);
	});
});

describe("system params", () => {
	it("are never offered for editing", () => {
		const withSystem: KeyValueItem[] = [
			{ id: "1", key: "page", value: "1", enabled: true },
			{ id: "2", key: "internal", value: "x", enabled: true, system: true },
		];
		expect(formatParamsToText(withSystem)).toBe("page=1");
	});
});

describe("a disabled row round-trips disabled (issue #1480)", () => {
	it("writes a disabled row with a leading `// `", () => {
		const rows: KeyValueItem[] = [
			{ id: "1", key: "debug", value: "1", enabled: false },
			{ id: "2", key: "page", value: "2", enabled: true },
		];
		expect(formatParamsToText(rows)).toBe("// debug=1\npage=2");
	});

	it("reads the marker back as enabled: false", () => {
		const parsed = parseParamsFromText("// debug=1\npage=2");
		expect(parsed.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
			{ key: "debug", value: "1", enabled: false },
			{ key: "page", value: "2", enabled: true },
		]);
	});

	it("disables a bare, valueless key too", () => {
		const parsed = parseParamsFromText("// verbose");
		expect(parsed[0]).toMatchObject({ key: "verbose", value: "", enabled: false });
	});
});

describe("a value keeps its whitespace (issue #1480)", () => {
	it("preserves a trailing space", () => {
		expect(pairs("q=hello ")).toEqual([{ key: "q", value: "hello " }]);
	});

	it("round-trips a value with meaningful whitespace unchanged", () => {
		const original: KeyValueItem[] = [{ id: "1", key: "q", value: "hello ", enabled: true }];
		expect(pairs(formatParamsToText(original))).toEqual([{ key: "q", value: "hello " }]);
	});
});

describe("isNoOpParamsEdit", () => {
	const rows: KeyValueItem[] = [
		{ id: "1", key: "page", value: "1", enabled: true },
		{ id: "2", key: "debug", value: "1", enabled: false },
	];

	it("is true for the exact text the panel would offer for these rows", () => {
		expect(isNoOpParamsEdit(formatParamsToText(rows), rows)).toBe(true);
	});

	it("ignores a system row on either side", () => {
		const withSystem: KeyValueItem[] = [
			...rows,
			{ id: "3", key: "internal", value: "x", enabled: true, system: true },
		];
		expect(isNoOpParamsEdit(formatParamsToText(rows), withSystem)).toBe(true);
	});

	it("is false when a row's enabled state actually changed", () => {
		const reEnabled = formatParamsToText(rows).replace("// debug=1", "debug=1");
		expect(isNoOpParamsEdit(reEnabled, rows)).toBe(false);
	});
});
