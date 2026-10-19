/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request section of the Headers tab is the frame's header block
 * (issue #2464). Each case names the line of the parser it holds.
 */

import { describe, expect, it } from "vitest";

import { parseWireHeaders, wireRequestHeadersField } from "./wire-headers";

const FRAME =
	"POST /pets HTTP/1.1\r\n" +
	"Host: api.example.com\r\n" +
	"Accept: */*\r\n" +
	"Content-Type: text/plain\r\n" +
	"Content-Length: 5\r\n" +
	"X-Mine: 1\r\n" +
	"\r\n" +
	"hello";

describe("parseWireHeaders", () => {
	it("lists every line of the header block, the author's and the transport's, in wire order", () => {
		expect(parseWireHeaders(FRAME)).toEqual([
			["Host", "api.example.com"],
			["Accept", "*/*"],
			["Content-Type", "text/plain"],
			["Content-Length", "5"],
			["X-Mine", "1"],
		]);
	});

	it("reads an LF-only frame the same as a CRLF one", () => {
		expect(parseWireHeaders(FRAME.replace(/\r\n/g, "\n"))).toEqual(parseWireHeaders(FRAME));
	});

	it("splits on the first colon, so a value keeps its own", () => {
		const frame = "GET / HTTP/1.1\r\nReferer: https://a.test:8080/x\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([["Referer", "https://a.test:8080/x"]]);
	});

	it("stops at the blank line: a body that looks like headers is not one", () => {
		const frame = "POST / HTTP/1.1\r\nHost: a.test\r\n\r\nX-Fake: 1\r\nAccept: nope\r\n";

		expect(parseWireHeaders(frame)).toEqual([["Host", "a.test"]]);
	});

	it("never reads the request line as a header", () => {
		// A request line with a colon in its target must not become a row.
		const frame = "GET /a:b HTTP/1.1\r\nHost: a.test\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([["Host", "a.test"]]);
	});

	it("keeps every line of a repeated name, in order and with its own spelling", () => {
		// Two lines on the wire are two rows: nothing here subtracts or merges.
		const frame =
			"GET / HTTP/1.1\r\nCookie: a=1\r\nX-Tag: one\r\ncookie: b=2\r\nX-Tag: two\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([
			["Cookie", "a=1"],
			["X-Tag", "one"],
			["cookie", "b=2"],
			["X-Tag", "two"],
		]);
	});

	it("joins a folded continuation line onto its header", () => {
		const frame = "GET / HTTP/1.1\r\nX-Long: one\r\n  two\r\nHost: a.test\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([
			["X-Long", "one two"],
			["Host", "a.test"],
		]);
	});

	it("skips a line with no colon and one that starts with one", () => {
		const frame = "GET / HTTP/1.1\r\nnonsense\r\n: orphan\r\nHost: a.test\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([["Host", "a.test"]]);
	});

	it("does not fold a continuation onto a header past a line that was skipped", () => {
		const frame = "GET / HTTP/1.1\r\nHost: a.test\r\nnonsense\r\n  stray\r\n\r\n";

		expect(parseWireHeaders(frame)).toEqual([["Host", "a.test"]]);
	});

	it("is empty with no frame, an empty one, or a request line alone", () => {
		expect(parseWireHeaders(undefined)).toEqual([]);
		expect(parseWireHeaders("")).toEqual([]);
		expect(parseWireHeaders("GET / HTTP/1.1")).toEqual([]);
	});
});

describe("wireRequestHeadersField", () => {
	const frame = "GET / HTTP/1.1\r\nHost: a.test\r\n\r\n";

	it("carries the lines for an exchange that got a response", () => {
		expect(wireRequestHeadersField(true, frame)).toEqual({
			wireRequestHeaders: [["Host", "a.test"]],
		});
	});

	it("leaves the key absent when the send failed", () => {
		expect(wireRequestHeadersField(false, frame)).toEqual({});
	});

	it("leaves the key absent when the frame holds no header lines", () => {
		expect(wireRequestHeadersField(true, "GET / HTTP/1.1\r\n\r\n")).toEqual({});
		expect(wireRequestHeadersField(true, undefined)).toEqual({});
	});
});
