/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bulk Edit accepted a format its own placeholder did not demonstrate.
 *
 * The Headers tab offered `Authorization: Bearer token` as the example to
 * follow, and the parser matched `/^([^=]+)=\s*(.*)$/` - colon lines matched
 * nothing. Unmatched lines are dropped silently, so following the placeholder,
 * or pasting a header block out of curl or devtools, returned an empty array,
 * and the panel wrote that empty array over the user's headers. No error, no
 * warning, every header gone.
 *
 * The first test below is that exact placeholder text. Revert `splitHeaderLine`
 * to the old equals-only regex and it fails with `[]`.
 */

import { describe, it, expect } from "vitest";
import { formatHeadersToText, parseHeadersFromText } from "./headers-format";
import { VERSION_HEADER_KEY } from "./system-headers";
import type { KeyValueItem } from "../types";

/** The parsed shape, minus the generated id that varies per call. */
const pairs = (text: string, skipVersion = true) =>
	parseHeadersFromText(text, skipVersion).map(({ key, value }) => ({ key, value }));

/** Build the array shape `formatHeadersToText` consumes. */
const items = (...kv: Array<[string, string]>): KeyValueItem[] =>
	kv.map(([key, value], i) => ({ id: `id-${i}`, key, value, enabled: true }));

describe("the format the panel tells the user to write", () => {
	it("parses the placeholder's own example", () => {
		// Verbatim from HeadersPanel's textarea placeholder.
		const placeholder = [
			"User-Agent: MyApp/1.0",
			"Authorization: Bearer token",
			"Content-Type: application/json",
		].join("\n");

		expect(pairs(placeholder)).toEqual([
			{ key: "User-Agent", value: "MyApp/1.0" },
			{ key: "Authorization", value: "Bearer token" },
			{ key: "Content-Type", value: "application/json" },
		]);
	});

	it("writes headers back in the same colon form it reads", () => {
		expect(formatHeadersToText(items(["Accept", "application/json"]))).toBe(
			"Accept: application/json"
		);
	});

	it("round-trips without drift", () => {
		const original = items(["Accept", "application/json"], ["X-Trace", "abc-123"]);
		expect(pairs(formatHeadersToText(original))).toEqual([
			{ key: "Accept", value: "application/json" },
			{ key: "X-Trace", value: "abc-123" },
		]);
	});
});

describe("the equals form still works", () => {
	it("accepts what the old parser accepted", () => {
		// Anything a user already had typed keeps parsing.
		expect(pairs("X-Legacy=value")).toEqual([{ key: "X-Legacy", value: "value" }]);
	});

	it("reads a mixed block one line at a time", () => {
		expect(pairs("Accept: application/json\nX-Legacy=value")).toEqual([
			{ key: "Accept", value: "application/json" },
			{ key: "X-Legacy", value: "value" },
		]);
	});
});

describe("which separator wins when a line holds both", () => {
	it("splits at the colon when the equals is inside the value", () => {
		// A bearer token, a base64 payload, a signed URL - all carry `=`.
		expect(pairs("Authorization: Bearer YWJjPT0=")).toEqual([
			{ key: "Authorization", value: "Bearer YWJjPT0=" },
		]);
	});

	it("splits at the equals when the colon is inside the value", () => {
		expect(pairs("X-Origin=https://example.com:8443")).toEqual([
			{ key: "X-Origin", value: "https://example.com:8443" },
		]);
	});

	it("keeps a bare port in a Host value attached to its host", () => {
		expect(pairs("Host: example.com:8080")).toEqual([
			{ key: "Host", value: "example.com:8080" },
		]);
	});
});

describe("lines that name no header", () => {
	it.each([
		["no separator at all", "justsometext"],
		["a leading colon", ": orphaned"],
		["a leading equals", "=orphaned"],
		["whitespace before the separator", "   : orphaned"],
	])("drops %s", (_label, line) => {
		expect(pairs(line)).toEqual([]);
	});

	it("drops blank lines without dropping the rest", () => {
		expect(pairs("Accept: text/html\n\n   \nX-Trace: 1")).toEqual([
			{ key: "Accept", value: "text/html" },
			{ key: "X-Trace", value: "1" },
		]);
	});
});

describe("the protected version header", () => {
	it("is skipped on the way in, so bulk edit cannot forge it", () => {
		expect(pairs(`${VERSION_HEADER_KEY}: 9.9.9\nAccept: */*`)).toEqual([
			{ key: "Accept", value: "*/*" },
		]);
	});

	it("is never offered for editing on the way out", () => {
		const text = formatHeadersToText(items([VERSION_HEADER_KEY, "1.0.0"], ["Accept", "*/*"]));
		expect(text).toBe("Accept: */*");
	});
});

describe("repeated names", () => {
	it("keeps both, which is what the panel's hint now says", () => {
		// The hint used to promise "duplicate keys will override previous
		// values". Nothing dedupes, and repeated headers are legal HTTP.
		expect(pairs("Set-Cookie: a=1\nSet-Cookie: b=2")).toEqual([
			{ key: "Set-Cookie", value: "a=1" },
			{ key: "Set-Cookie", value: "b=2" },
		]);
	});
});
