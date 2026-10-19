/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The "Added by libcurl" group is the wire frame minus the sent record
 * (issue #2464). Each case names the line of the parser it holds.
 */

import { describe, expect, it } from "vitest";

import { libcurlAddedHeaders, libcurlHeadersField } from "./libcurl-headers";

const FRAME =
	"POST /pets HTTP/1.1\r\n" +
	"Host: api.example.com\r\n" +
	"Accept: */*\r\n" +
	"Content-Type: text/plain\r\n" +
	"Content-Length: 5\r\n" +
	"X-Mine: 1\r\n" +
	"\r\n" +
	"hello";

describe("libcurlAddedHeaders", () => {
	it("lists the lines on the wire that the sent record lacks, in wire order", () => {
		const added = libcurlAddedHeaders(FRAME, { "Content-Type": "text/plain", "X-Mine": "1" });

		expect(Object.entries(added)).toEqual([
			["Host", "api.example.com"],
			["Accept", "*/*"],
			["Content-Length", "5"],
		]);
	});

	it("does not repeat the Content-Type the engine derived into the sent record", () => {
		const added = libcurlAddedHeaders(FRAME, { "content-type": "text/plain" });

		expect(added).not.toHaveProperty("Content-Type");
	});

	it("excludes sent names case-insensitively, in both directions", () => {
		const frame = "GET / HTTP/1.1\r\nhost: a.test\r\nACCEPT: */*\r\nCookie: a=1\r\n\r\n";

		expect(libcurlAddedHeaders(frame, { Host: "a.test", accept: "*/*" })).toEqual({
			Cookie: "a=1",
		});
	});

	it("reads an LF-only frame the same as a CRLF one", () => {
		const lf = FRAME.replace(/\r\n/g, "\n");

		expect(libcurlAddedHeaders(lf, { "Content-Type": "text/plain", "X-Mine": "1" })).toEqual(
			libcurlAddedHeaders(FRAME, { "Content-Type": "text/plain", "X-Mine": "1" })
		);
	});

	it("splits on the first colon, so a value keeps its own", () => {
		const frame = "GET / HTTP/1.1\r\nReferer: https://a.test:8080/x\r\n\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ Referer: "https://a.test:8080/x" });
	});

	it("stops at the blank line: a body that looks like headers is not one", () => {
		const frame = "POST / HTTP/1.1\r\nHost: a.test\r\n\r\nX-Fake: 1\r\nAccept: nope\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ Host: "a.test" });
	});

	it("never reads the request line as a header", () => {
		// A request line with a colon in its target must not become a row.
		const frame = "GET /a:b HTTP/1.1\r\nHost: a.test\r\n\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ Host: "a.test" });
	});

	it("keeps the first of a repeated name", () => {
		const frame = "GET / HTTP/1.1\r\nCookie: a=1\r\ncookie: b=2\r\n\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ Cookie: "a=1" });
	});

	it("joins a folded continuation line onto its header", () => {
		const frame = "GET / HTTP/1.1\r\nX-Long: one\r\n  two\r\nHost: a.test\r\n\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ "X-Long": "one two", Host: "a.test" });
	});

	it("drops the continuation of a header that was excluded", () => {
		const frame = "GET / HTTP/1.1\r\nX-Sent: one\r\n two\r\nHost: a.test\r\n\r\n";

		expect(libcurlAddedHeaders(frame, { "X-Sent": "one two" })).toEqual({ Host: "a.test" });
	});

	it("skips a line with no colon and one that starts with one", () => {
		const frame = "GET / HTTP/1.1\r\nnonsense\r\n: orphan\r\nHost: a.test\r\n\r\n";

		expect(libcurlAddedHeaders(frame, {})).toEqual({ Host: "a.test" });
	});

	it("is empty with no frame, an empty one, or a request line alone", () => {
		expect(libcurlAddedHeaders(undefined, {})).toEqual({});
		expect(libcurlAddedHeaders("", {})).toEqual({});
		expect(libcurlAddedHeaders("GET / HTTP/1.1", {})).toEqual({});
	});

	it("treats every wire line as added when no sent record exists", () => {
		expect(libcurlAddedHeaders("GET / HTTP/1.1\r\nHost: a.test\r\n\r\n", undefined)).toEqual({
			Host: "a.test",
		});
	});
});

describe("libcurlHeadersField", () => {
	const frame = "GET / HTTP/1.1\r\nHost: a.test\r\n\r\n";

	it("carries the group for an exchange that got a response", () => {
		expect(libcurlHeadersField(true, frame, {})).toEqual({
			libcurlHeaders: { Host: "a.test" },
		});
	});

	it("leaves the key absent when the send failed", () => {
		expect(libcurlHeadersField(false, frame, {})).toEqual({});
	});

	it("leaves the key absent when libcurl added nothing", () => {
		expect(libcurlHeadersField(true, frame, { Host: "a.test" })).toEqual({});
	});
});
