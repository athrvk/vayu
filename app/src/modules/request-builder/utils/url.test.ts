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
import { appendParamsToUrl, buildUrlWithParams, parseQueryParams } from "./url";
import type { KeyValueEntry } from "@/types";

const kv = (key: string, value: string, enabled = true): KeyValueEntry => ({
	key,
	value,
	enabled,
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
