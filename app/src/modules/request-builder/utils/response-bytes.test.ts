/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's half of issue #2458: the engine sends a body that is not
 * UTF-8 as base64 and decodes no charset, so a declared one is honoured here
 * or nowhere. Fixtures are the measured cases from the issue, as raw bytes.
 */

import { describe, expect, it } from "vitest";

import {
	decodeResponseBody,
	extensionForContentType,
	heldBodySize,
	receivedBody,
} from "./response-bytes";

const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const typed = (contentType: string) => ({ "content-type": contentType });

describe("decodeResponseBody", () => {
	it("passes a utf8 body through, and an absent encoding is utf8", () => {
		expect(decodeResponseBody({ bodyRaw: "café", bodyEncoding: "utf8" })).toEqual({
			text: "café",
		});
		expect(decodeResponseBody({ bodyRaw: "café" })).toEqual({ text: "café" });
	});

	it("reads Latin-1 by its declared charset", () => {
		const bytes = [...ascii("caf"), 0xe9, ...ascii(" na"), 0xef, ...ascii("ve")];
		const decoded = decodeResponseBody({
			bodyRaw: base64(bytes),
			bodyEncoding: "base64",
			headers: typed("text/plain; charset=iso-8859-1"),
		});

		expect(decoded.text).toBe("café naïve");
		expect(Array.from(decoded.bytes?.data ?? [])).toEqual(bytes);
		expect(decoded.bytes?.isText).toBe(true);
		expect(decoded.bytes?.notice).toBeUndefined();
	});

	it("reads Windows-1252 by its declared, quoted charset", () => {
		const bytes = [
			...ascii('{"s":"'),
			0x93,
			...ascii("quoted"),
			0x94,
			0x20,
			0x80,
			...ascii('"}'),
		];
		const decoded = decodeResponseBody({
			bodyRaw: base64(bytes),
			bodyEncoding: "base64",
			headers: { "Content-Type": 'application/json; charset="windows-1252"' },
		});

		// Compared against the platform's own windows-1252 reading rather than
		// spelled out: Chromium maps 0x93/0x94/0x80 to curly quotes and the euro
		// sign, while the Node these tests run on maps 0x80-0x9F to C1 controls.
		// Either way it is that decoder, not UTF-8's replacement characters.
		const windows1252 = new TextDecoder("windows-1252").decode(new Uint8Array(bytes));
		expect(decoded.text).toBe(windows1252);
		expect(decoded.text).not.toContain("�");
		expect(decoded.text.startsWith('{"s":"')).toBe(true);
		expect(decoded.bytes?.notice).toBeUndefined();
	});

	it("follows a UTF-16 byte-order mark, declared or not", () => {
		const bytes = [0xff, 0xfe, 0x68, 0x00, 0x69, 0x00];
		for (const contentType of ["text/plain; charset=utf-16", "text/plain"]) {
			const decoded = decodeResponseBody({
				bodyRaw: base64(bytes),
				bodyEncoding: "base64",
				headers: typed(contentType),
			});
			expect(decoded.text, contentType).toBe("hi");
		}
	});

	it("falls back to UTF-8 for a label it does not know, and says so", () => {
		const decoded = decodeResponseBody({
			bodyRaw: base64([...ascii("ok"), 0xff]),
			bodyEncoding: "base64",
			headers: typed("text/plain; charset=x-made-up"),
		});

		expect(decoded.text).toBe("ok�");
		expect(decoded.bytes?.notice).toEqual({
			charset: "utf-8",
			unknownLabel: "x-made-up",
			replaced: true,
		});
	});

	it("says so when a declared UTF-8 body is not", () => {
		const decoded = decodeResponseBody({
			bodyRaw: base64([...ascii('{"s":"ok'), 0xff, 0xfe, ...ascii('"}')]),
			bodyEncoding: "base64",
			headers: typed("application/json; charset=utf-8"),
		});

		expect(decoded.bytes?.notice).toEqual({ charset: "utf-8", replaced: true });
	});

	it("keeps an image's bytes exactly and gives it no text", () => {
		const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
		const decoded = decodeResponseBody({
			bodyRaw: base64(png),
			bodyEncoding: "base64",
			headers: typed("image/png"),
		});

		expect(decoded.text).toBe("");
		expect(decoded.bytes?.isText).toBe(false);
		expect(Array.from(decoded.bytes?.data ?? [])).toEqual(png);
	});

	it("treats an unlabelled base64 body as bytes, not as text to guess at", () => {
		const decoded = decodeResponseBody({ bodyRaw: base64([0, 1, 2]), bodyEncoding: "base64" });

		expect(decoded.bytes?.isText).toBe(false);
	});

	it("reads SVG as the text it is", () => {
		const decoded = decodeResponseBody({
			bodyRaw: base64(ascii("<svg/>\0")),
			bodyEncoding: "base64",
			headers: typed("image/svg+xml"),
		});

		expect(decoded.bytes?.isText).toBe(true);
		expect(decoded.text).toBe("<svg/>\0");
	});

	// A zip's bytes include NUL and stray high bytes, which is why the engine
	// sent it as base64; the type is what must keep it bytes.
	const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0xff];

	it.each([
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.ms-excel",
	])("keeps %s as bytes, whatever its subtype spells", (contentType) => {
		const decoded = decodeResponseBody({
			bodyRaw: base64(ZIP),
			bodyEncoding: "base64",
			headers: typed(contentType),
		});

		expect(decoded.text).toBe("");
		expect(decoded.bytes?.isText).toBe(false);
		expect(Array.from(decoded.bytes?.data ?? [])).toEqual(ZIP);
	});

	it.each([
		"application/atom+xml",
		"application/ld+json",
		"application/vnd.api+json; charset=utf-8",
		"application/openapi+yaml",
		"text/x-yaml",
		"application/x-yaml",
		"application/yaml",
		"application/x-www-form-urlencoded",
		"application/x-javascript",
		"application/graphql",
		"application/x-ndjson",
	])("reads %s as text", (contentType) => {
		const decoded = decodeResponseBody({
			bodyRaw: base64([...ascii("a: "), 0xe9]),
			bodyEncoding: "base64",
			headers: typed(contentType),
		});

		expect(decoded.bytes?.isText).toBe(true);
		expect(decoded.text.startsWith("a: ")).toBe(true);
	});

	it("refuses a body that is not base64, and an encoding it does not know", () => {
		expect(() => decodeResponseBody({ bodyRaw: "%%%", bodyEncoding: "base64" })).toThrow(
			/does not decode/
		);
		expect(() => decodeResponseBody({ bodyRaw: "x", bodyEncoding: "gzip" })).toThrow(
			/unknown encoding: gzip/
		);
	});
});

describe("heldBodySize", () => {
	it("counts the bytes when there are some, never the text", () => {
		const data = new Uint8Array(9);
		expect(heldBodySize({ body: "", rawBytes: { data, isText: false } })).toBe(9);
		expect(heldBodySize({ body: "abc" })).toBe(3);
	});

	it("counts the received text, not the longer indented copy", () => {
		expect(heldBodySize({ body: '{\n  "a": 1\n}', bodyRaw: '{"a":1}' })).toBe(7);
	});
});

describe("receivedBody", () => {
	it("is the received text, not the indented pane copy", () => {
		const pane = '{\n  "a": 1\n}';
		expect(receivedBody({ body: pane, bodyRaw: '{"a":1}' })).toBe('{"a":1}');
	});

	it("falls back to body where no bodyRaw was recorded or it is empty", () => {
		expect(receivedBody({ body: "message" })).toBe("message");
		expect(receivedBody({ body: "message", bodyRaw: "" })).toBe("message");
	});
});

describe("extensionForContentType", () => {
	it.each([
		["image/png", "png"],
		["image/jpeg", "jpg"],
		["application/pdf", "pdf"],
		["application/octet-stream", "bin"],
		["text/plain; charset=iso-8859-1", "txt"],
		["image/svg+xml", "svg"],
		["application/x-tar", "tar"],
		["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "bin"],
		// A structured-syntax suffix names the format when the subtype is no extension.
		["application/problem+json", "json"],
		["application/vnd.api+json; charset=utf-8", "json"],
		["application/ld+json", "json"],
		["application/atom+xml", "xml"],
		["application/xhtml+xml", "xml"],
		["application/vnd.foo+cbor", "cbor"],
		["", "bin"],
	])("%s -> %s", (contentType, extension) => {
		expect(extensionForContentType(contentType)).toBe(extension);
	});
});
