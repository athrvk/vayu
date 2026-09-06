/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two join rules and the parser that reads them back.
 *
 * `buildUrlWithParams` (the Params table: the rows *are* the query) and
 * `appendParamsToUrl` (import: the rows are *additional* to the query the URL
 * already carries) differ in exactly one case - a URL that arrives with a query
 * of its own - and that case is what issue #590 turns on, so it is pinned on
 * both sides rather than assumed.
 */

import { describe, it, expect } from "vitest";
import { appendParamsToUrl, buildUrlWithParams, mergeParamsFromUrl, parseQueryParams } from "./url";
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

	it("encodes keys and values, but leaves {{variables}} alone", () => {
		expect(buildUrlWithParams("https://x/y", [kv("q", "a b&c"), kv("id", "{{userId}}")])).toBe(
			"https://x/y?q=a%20b%26c&id={{userId}}"
		);
	});
});

describe("appendParamsToUrl", () => {
	it("keeps the URL's own query and appends the rows after it", () => {
		expect(appendParamsToUrl("https://x/y?a=1", [kv("b", "2")])).toBe("https://x/y?a=1&b=2");
	});

	it("starts a query when the URL has none", () => {
		expect(appendParamsToUrl("{{baseUrl}}/users", [kv("page", "1")])).toBe(
			"{{baseUrl}}/users?page=1"
		);
	});

	it("leaves a URL with nothing to append exactly as it was", () => {
		// The disabled-row trap: an import must keep the row in the table and out
		// of the wire, and must not strip a query the source put in the URL.
		expect(appendParamsToUrl("https://x/y?a=1", [kv("b", "2", false)])).toBe("https://x/y?a=1");
		expect(appendParamsToUrl("https://x/y", [])).toBe("https://x/y");
	});

	it("does not double the separator on a URL that already ends in one", () => {
		expect(appendParamsToUrl("https://x/y?", [kv("a", "1")])).toBe("https://x/y?a=1");
		expect(appendParamsToUrl("https://x/y?a=1&", [kv("b", "2")])).toBe("https://x/y?a=1&b=2");
	});

	it("round-trips through parseQueryParams", () => {
		const joined = appendParamsToUrl("https://x/y", [kv("q", "a b"), kv("id", "{{userId}}")]);
		expect(parseQueryParams(joined).map(({ key, value }) => ({ key, value }))).toEqual([
			{ key: "q", value: "a b" },
			{ key: "id", value: "{{userId}}" },
		]);
	});
});

describe("mergeParamsFromUrl", () => {
	it("keeps a disabled row when the URL gains a new enabled param", () => {
		// Mutation check: replacing wholesale with parseQueryParams(url) instead
		// of merging drops the disabled row here.
		const existing = [item("1", "a", "1", true), item("2", "b", "2", false)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1&c=3");
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
		const merged = mergeParamsFromUrl(existing, "https://x/y");
		expect(merged.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
			{ key: "b", value: "2", enabled: false },
		]);
	});

	it("preserves id, description and source for a row whose key survives", () => {
		const existing = [
			item("keep-me", "a", "1", true, { description: "note", source: "body-mode" }),
		];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=9");
		expect(merged).toEqual([
			item("keep-me", "a", "9", true, { description: "note", source: "body-mode" }),
		]);
	});

	it("appends a brand-new key at the end with a fresh id", () => {
		const existing = [item("1", "a", "1", true)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1&z=9");
		expect(merged[0].id).toBe("1");
		expect(merged[1]).toMatchObject({ key: "z", value: "9", enabled: true });
		expect(merged[1].id).not.toBe("1");
	});

	it("never lists an enabled row the URL does not carry", () => {
		const existing = [item("1", "a", "1", true), item("2", "gone", "x", true)];
		const merged = mergeParamsFromUrl(existing, "https://x/y?a=1");
		expect(merged.map((p) => p.key)).toEqual(["a"]);
	});
});
