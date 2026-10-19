/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import {
	describeOriginPolicy,
	MAX_ALLOWED_ORIGINS,
	MAX_ALLOWED_ORIGIN_BYTES,
	parseAllowedOrigins,
	summarizeOriginPolicy,
} from "./allowed-origins";

describe("parseAllowedOrigins", () => {
	it("reads one origin per line", () => {
		expect(parseAllowedOrigins("https://app.example.com\nhttp://localhost:5173")).toEqual({
			origins: ["https://app.example.com", "http://localhost:5173"],
			error: null,
		});
	});

	it("trims lines, drops blank ones and accepts CRLF", () => {
		expect(
			parseAllowedOrigins("\n  https://a.example  \r\n\r\n\t\r\nhttps://b.example\n\n")
		).toEqual({ origins: ["https://a.example", "https://b.example"], error: null });
	});

	it("is the empty default for empty or blank text", () => {
		expect(parseAllowedOrigins("")).toEqual({ origins: [], error: null });
		expect(parseAllowedOrigins("  \n\n \t")).toEqual({ origins: [], error: null });
	});

	it("sends the engine's canonical spelling, so what it echoes is what was typed", () => {
		expect(parseAllowedOrigins("HTTPS://App.Example.COM:443\nhttp://localhost:80")).toEqual({
			origins: ["https://app.example.com", "http://localhost"],
			error: null,
		});
	});

	it("lists an origin once, however many spellings of it there are", () => {
		expect(
			parseAllowedOrigins(
				"https://app.example.com\nhttps://APP.example.com:443\nhttps://app.example.com"
			)
		).toEqual({ origins: ["https://app.example.com"], error: null });
	});

	it.each([
		["a bare host", "app.example.com", /must start http:\/\/ or https:\/\//],
		["another scheme", "ftp://app.example.com", /must start http:\/\/ or https:\/\//],
		["a trailing slash", "https://app.example.com/", /path, query or fragment/],
		["a path", "https://app.example.com/app", /path, query or fragment/],
		["a query", "https://app.example.com?x=1", /path, query or fragment/],
		["a fragment", "https://app.example.com#top", /path, query or fragment/],
		["a user name", "https://user@app.example.com", /user name or password/],
		["a wildcard", "https://*.example.com", /wildcard/],
		["the opaque origin", "null", /opaque origin/],
		["inner whitespace", "https://app example.com", /whitespace/],
		["no host", "https://", /no host/],
		["a port past 65535", "http://localhost:99999", /valid host and port/],
		["an empty host", "http://:8080", /valid host and port/],
	])("refuses %s, naming the line", (_name, line, reason) => {
		const parsed = parseAllowedOrigins(`https://ok.example\n${line}`);
		expect(parsed.origins).toEqual([]);
		expect(parsed.error).toContain(`Couldn't use "${line}"`);
		expect(parsed.error).toMatch(reason);
	});

	it("refuses the whole list over one bad line rather than dropping it", () => {
		const parsed = parseAllowedOrigins("https://a.example\nnope\nhttps://b.example");
		expect(parsed.origins).toEqual([]);
		expect(parsed.error).toContain('"nope"');
	});

	it("holds the engine's count bound", () => {
		const lines = (n: number) =>
			Array.from({ length: n }, (_, i) => `https://h${i}.example`).join("\n");
		expect(parseAllowedOrigins(lines(MAX_ALLOWED_ORIGINS)).error).toBeNull();
		const tooMany = parseAllowedOrigins(lines(MAX_ALLOWED_ORIGINS + 1));
		expect(tooMany.origins).toEqual([]);
		expect(tooMany.error).toBe(
			`Couldn't list ${MAX_ALLOWED_ORIGINS + 1} origins - at most ${MAX_ALLOWED_ORIGINS}.`
		);
	});

	it("holds the engine's length bound in bytes, not characters", () => {
		const host = (length: number) => "a".repeat(length - "https://.example".length);
		const atBound = `https://${host(MAX_ALLOWED_ORIGIN_BYTES)}.example`;
		expect(atBound.length).toBe(MAX_ALLOWED_ORIGIN_BYTES);
		expect(parseAllowedOrigins(atBound).error).toBeNull();
		expect(parseAllowedOrigins(`${atBound}a`).error).toMatch(/longer than 512 bytes/);
		// 300 two-byte characters are under 512 characters and over 512 bytes.
		expect(parseAllowedOrigins(`https://${"é".repeat(300)}.example`).error).toMatch(
			/longer than 512 bytes/
		);
	});
});

describe("describing a policy", () => {
	it("says any for the default and lists the origins otherwise", () => {
		expect(describeOriginPolicy([])).toBe("Origins: any");
		expect(describeOriginPolicy(["https://a.example", "http://localhost:5173"])).toBe(
			"Origins: https://a.example, http://localhost:5173"
		);
	});

	it("counts the origins where there is no room to list them", () => {
		expect(summarizeOriginPolicy([])).toBe("Any origin");
		expect(summarizeOriginPolicy(["https://a.example"])).toBe("1 origin");
		expect(summarizeOriginPolicy(["https://a.example", "https://b.example"])).toBe("2 origins");
	});
});
