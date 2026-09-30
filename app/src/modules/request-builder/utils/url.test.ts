/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Params table's join rule, `buildUrlWithParams` (the rows *are* the
 * query), and the parser that reads a URL back into rows.
 */

import { describe, it, expect } from "vitest";
import { buildUrlWithParams, mergeParamsFromUrl, paramsFromUrl, parseQueryParams } from "./url";
import type { KeyValueEntry, KeyValueItem } from "@/types";

const kv = (key: string, value: string, enabled = true): KeyValueEntry => ({
	key,
	value,
	enabled,
});

const item = (
	id: string,
	key: string,
	value: string,
	enabled = true,
	extra: Partial<KeyValueItem> = {}
): KeyValueItem => ({
	id,
	key,
	value,
	enabled,
	...extra,
});

describe("buildUrlWithParams", () => {
	it("replaces the URL's existing query with the rows", () => {
		expect(buildUrlWithParams("https://x/y?stale=1", [kv("page", "1")])).toBe(
			"https://x/y?page=1"
		);
	});

	it("clears the query when no row is enabled - the table is the whole truth", () => {
		expect(buildUrlWithParams("https://x/y?page=1", [kv("page", "1", false)])).toBe(
			"https://x/y"
		);
		expect(buildUrlWithParams("https://x/y?page=1", [])).toBe("https://x/y");
	});

	it("drops rows with no key, and writes a valueless row as a bare key", () => {
		expect(buildUrlWithParams("https://x/y", [kv("  ", "1"), kv("page", "")])).toBe(
			"https://x/y?page"
		);
	});

	it("encodes keys and values with Postman's query rule, and leaves {{variables}} alone", () => {
		// `|` is raw, space and `&` are encoded (issue #1771); the fixture in
		// `query-encoding.conformance.test.ts` holds the whole rule.
		expect(
			buildUrlWithParams("https://x/y", [kv("q", "a b&c|d"), kv("id", "{{userId}}")])
		).toBe("https://x/y?q=a%20b%26c|d&id={{userId}}");
	});

	it("writes rows as typed for a request sent without encoding (#1765)", () => {
		// The engine sends the URL's query as written under
		// `disableUrlEncoding`, so the table must not encode what then goes out
		// raw - `a|b` stays `a|b`.
		expect(
			buildUrlWithParams("https://x/y", [kv("q", "a|b"), kv("k[]", "1")], { encode: false })
		).toBe("https://x/y?q=a|b&k[]=1");
	});
});

describe("mergeParamsFromUrl", () => {
	it("keeps a disabled row when the URL gains a new enabled param", () => {
		// Mutation check: replacing wholesale with parseQueryParams(url) instead
		// of merging drops the disabled row here.
		const existing = [item("1", "a", "1", true), item("2", "b", "2", false)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1&c=3", "https://x/y");
		expect(merged.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
			{ key: "a", value: "1", enabled: true },
			{ key: "b", value: "2", enabled: false },
			{ key: "c", value: "3", enabled: true },
		]);
	});

	it("clearing the query drops enabled rows and keeps disabled ones", () => {
		// Mutation check: restoring the `newParams.length > 0` guard leaves the
		// stale enabled row in place here.
		const existing = [item("1", "a", "1", true), item("2", "b", "2", false)];
		const merged = mergeParamsFromUrl(existing, "https://x/y", "https://x/y");
		expect(merged.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
			{ key: "b", value: "2", enabled: false },
		]);
	});

	it("preserves id, description and source for a row whose key survives", () => {
		const existing = [
			item("keep-me", "a", "1", true, { description: "note", source: "body-mode" }),
		];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=9", "https://x/y");
		expect(merged).toEqual([
			item("keep-me", "a", "9", true, { description: "note", source: "body-mode" }),
		]);
	});

	it("appends a brand-new key at the end with a fresh id", () => {
		const existing = [item("1", "a", "1", true)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1&z=9", "https://x/y");
		expect(merged[0].id).toBe("1");
		expect(merged[1]).toMatchObject({ key: "z", value: "9", enabled: true });
		expect(merged[1].id).not.toBe("1");
	});

	it("never lists an enabled row the URL does not carry", () => {
		const existing = [item("1", "a", "1", true), item("2", "gone", "x", true)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1", "https://x/y");
		expect(merged.map((p) => p.key)).toEqual(["a"]);
	});
});

/**
 * Rows hold the query as the URL spells it (issue #1771), in either encoding
 * mode, and a table edit rewrites only the pairs it touches.
 */
describe("the query as written", () => {
	const URL = "https://x/y?redirect=https%3A%2F%2Fa.b%2F%3Fx%3D1%26y%3D2&q=a%20b&b=1";

	it("reads rows raw and rebuilds exactly the query they came from", () => {
		const rows = parseQueryParams(URL);
		expect(rows.map(({ key, value }) => [key, value])).toEqual([
			["redirect", "https%3A%2F%2Fa.b%2F%3Fx%3D1%26y%3D2"],
			["q", "a%20b"],
			["b", "1"],
		]);
		const edited = rows.map((r) => (r.key === "b" ? { ...r, value: "2" } : r));
		const expected = "https://x/y?redirect=https%3A%2F%2Fa.b%2F%3Fx%3D1%26y%3D2&q=a%20b&b=2";
		expect(buildUrlWithParams(URL, edited)).toBe(expected);
		expect(buildUrlWithParams(URL, edited, { encode: false })).toBe(expected);
	});

	it("keeps an escaped + through an edit of another row", () => {
		// Mutation check: decoding in `parseQueryParams` turns the row into
		// `a+b`, which is written back raw as `a+b` - a server reads a space.
		const url = "https://x/?q=a%2Bb&n=1";
		const rows = parseQueryParams(url);
		expect(rows[0].value).toBe("a%2Bb");
		const edited = rows.map((r) => (r.key === "n" ? { ...r, value: "2" } : r));
		expect(buildUrlWithParams(url, edited)).toBe("https://x/?q=a%2Bb&n=2");
	});

	it("keeps the bytes of a row an older version stored decoded", () => {
		// A row read decoded before #1771 (`+05:00` from `%2B05%3A00`). Mutation
		// check: encoding every row, with no byte preservation, writes
		// `tz=+05:00` here, whose `+` a server reads as a space.
		const url = "https://x/?tz=%2B05%3A00&x=1";
		const rows = [item("1", "tz", "+05:00"), item("2", "x", "2")];
		expect(buildUrlWithParams(url, rows)).toBe("https://x/?tz=%2B05%3A00&x=2");
	});

	it("keeps an encodeURIComponent join and a Postman key= untouched", () => {
		const url = "https://x/?a=p%7Cq&flag=&c=1";
		const rows = [item("1", "a", "p|q"), item("2", "flag", ""), item("3", "c", "1")];
		expect(buildUrlWithParams(url, rows)).toBe(url);
	});

	it("encodes a row the URL does not carry, and uses each pair once", () => {
		const url = "https://x/?a=1";
		expect(buildUrlWithParams(url, [item("1", "a", "1"), item("2", "a", "1")])).toBe(
			"https://x/?a=1&a=1"
		);
		expect(buildUrlWithParams(url, [item("1", "a", "c d")])).toBe("https://x/?a=c%20d");
	});

	it("merges the URL's query as written", () => {
		const existing = [item("1", "q", "old")];
		expect(mergeParamsFromUrl(existing, URL, URL)[0]).toMatchObject({
			id: "1",
			key: "q",
			value: "a%20b",
		});
	});
});

/**
 * Path rows (issue #1764) live in the same `params` array as the query rows,
 * and the join must never write one into the query string.
 */
describe("path rows", () => {
	const pathRow = (key: string, value: string): KeyValueEntry => ({
		key,
		value,
		enabled: true,
		in: "path",
	});

	it("never reach the query", () => {
		const params = [kv("page", "1"), pathRow("id", "42")];
		expect(buildUrlWithParams("https://x/users/:id", params)).toBe(
			"https://x/users/:id?page=1"
		);
		expect(buildUrlWithParams("https://x/users/:id?page=1", [pathRow("id", "42")])).toBe(
			"https://x/users/:id"
		);
	});

	it("follow the URL's segments through a merge, after the query rows", () => {
		const existing = [
			item("q", "page", "1"),
			item("p", "id", "42", true, { in: "path", description: "user" }),
		];
		const merged = mergeParamsFromUrl(
			existing,
			"https://x/users/:id/posts/:postId?page=2",
			"https://x/users/:id?page=1"
		);
		expect(merged.map(({ key, value, in: at }) => ({ key, value, in: at }))).toEqual([
			{ key: "page", value: "2", in: undefined },
			{ key: "id", value: "42", in: "path" },
			{ key: "postId", value: "", in: "path" },
		]);
		// The kept row is the same row, description and id included.
		expect(merged[1]).toBe(existing[1]);
	});

	it("are renamed with their value when a segment is edited, and dropped when it goes", () => {
		const existing = [item("p", "id", "42", true, { in: "path" })];
		expect(
			mergeParamsFromUrl(existing, "https://x/users/:userId", "https://x/users/:id")
		).toEqual([{ ...existing[0], key: "userId" }]);
		expect(mergeParamsFromUrl(existing, "https://x/users", "https://x/users/:id")).toEqual([]);
	});

	it("are left alone by an edit that does not touch the path's segments", () => {
		// A declared row no segment uses (a Postman `url.variable` entry) is
		// exported; a query-only edit must not drop it. Mutation check: syncing
		// the path rows on every URL edit drops `unused` here.
		const existing = [
			item("q", "x", "1"),
			item("a", "a", "1", true, { in: "path" }),
			item("u", "unused", "SECRET", true, { in: "path" }),
		];
		const merged = mergeParamsFromUrl(existing, "https://x/:a?x=2", "https://x/:a?x=1");
		expect(merged.slice(1)).toEqual(existing.slice(1));
	});

	it("are never matched by a same-named query key", () => {
		// `?id=1` is a query row; the `:id` row stays a path row with its value.
		const existing = [item("p", "id", "42", true, { in: "path" })];
		const merged = mergeParamsFromUrl(existing, "https://x/:id?id=1", "https://x/:id");
		expect(merged.map(({ key, value, in: at }) => ({ key, value, in: at }))).toEqual([
			{ key: "id", value: "1", in: undefined },
			{ key: "id", value: "42", in: "path" },
		]);
	});
});

describe("paramsFromUrl", () => {
	it("states the query, then an empty path row per segment", () => {
		expect(
			paramsFromUrl("https://x/:id?a=1").map(({ key, value, in: at }) => ({
				key,
				value,
				in: at,
			}))
		).toEqual([
			{ key: "a", value: "1", in: undefined },
			{ key: "id", value: "", in: "path" },
		]);
		expect(paramsFromUrl("https://x/y?a=1").every((p) => p.in === undefined)).toBe(true);
	});
});
