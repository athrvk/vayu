/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The XML indenter behind the response viewer's Pretty toggle.
 *
 * Two things are being pinned. First that it indents at all - Pretty and Raw
 * were byte-identical for XML before this existed, which is the bug. Second,
 * and the half more likely to break later, that it *stops* rather than guessing:
 * a document it cannot walk, and content whose whitespace is meaningful, come
 * back exactly as they arrived.
 */

import { describe, it, expect } from "vitest";
import { formatXml } from "./xml-format";

describe("indenting a document", () => {
	// The reported bug, stated directly: this is what Pretty owes over Raw.
	// Mutation check: return the source unchanged from `formatXml` and this is
	// the first case to redden.
	it("puts each element on its own line, one level per depth", () => {
		expect(formatXml("<a><b><c>1</c></b></a>")).toBe(
			["<a>", "  <b>", "    <c>1</c>", "  </b>", "</a>"].join("\n")
		);
	});

	it("keeps a leaf's text on the tag's line", () => {
		// `<c>\n  1\n</c>` would add whitespace to the element's text content,
		// and is harder to read for the value it is showing.
		expect(formatXml("<order><id>ACC-8813</id></order>")).toBe(
			["<order>", "  <id>ACC-8813</id>", "</order>"].join("\n")
		);
	});

	it("keeps attributes on their element, untouched", () => {
		expect(formatXml('<a><b id="1" note="x y">v</b></a>')).toBe(
			["<a>", '  <b id="1" note="x y">v</b>', "</a>"].join("\n")
		);
	});

	it("treats a self-closing element as one line at its depth", () => {
		expect(formatXml("<a><b/><c><d/></c></a>")).toBe(
			["<a>", "  <b/>", "  <c>", "    <d/>", "  </c>", "</a>"].join("\n")
		);
	});

	it("writes an empty element pair on one line", () => {
		expect(formatXml("<a><b></b></a>")).toBe(["<a>", "  <b></b>", "</a>"].join("\n"));
	});

	it("puts the declaration on its own line without indenting the root", () => {
		expect(formatXml('<?xml version="1.0"?><root><a>1</a></root>')).toBe(
			['<?xml version="1.0"?>', "<root>", "  <a>1</a>", "</root>"].join("\n")
		);
	});

	it("re-indents a document that was already indented, differently", () => {
		// The common case for a response: a server's four-space output read at
		// two, with no residue of the original indentation.
		const source = "<a>\n    <b>\n        <c>1</c>\n    </b>\n</a>";
		expect(formatXml(source)).toBe(
			["<a>", "  <b>", "    <c>1</c>", "  </b>", "</a>"].join("\n")
		);
	});

	it("indents a SOAP envelope, namespace prefixes and all", () => {
		const source =
			'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
			"<soap:Body><GetBalance><Account>ACC-8813</Account></GetBalance></soap:Body>" +
			"</soap:Envelope>";
		expect(formatXml(source)).toBe(
			[
				'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
				"  <soap:Body>",
				"    <GetBalance>",
				"      <Account>ACC-8813</Account>",
				"    </GetBalance>",
				"  </soap:Body>",
				"</soap:Envelope>",
			].join("\n")
		);
	});
});

describe("what it refuses to touch", () => {
	// The `format.ts` contract, and the reason a string walk is safe to ship: a
	// body mid-edit renders as what the user typed.
	it.each([
		["an unterminated tag", "<a><b</a>"],
		["a close tag naming something else", "<a><b></c></a>"],
		["a close with nothing open", "</a>"],
		["an element left open", "<a><b>1</b>"],
	])("returns %s unchanged", (_label, source) => {
		expect(formatXml(source)).toBe(source);
	});

	it("returns a body still holding an unresolved token unchanged when it breaks the walk", () => {
		const source = "<order><id>{{orderId}}</id>";
		expect(formatXml(source)).toBe(source);
	});

	it("indents one that stays well-formed around its tokens", () => {
		// A token inside text is just text, so this one is formattable and the
		// token survives it verbatim.
		expect(formatXml("<order><id>{{orderId}}</id></order>")).toBe(
			["<order>", "  <id>{{orderId}}</id>", "</order>"].join("\n")
		);
	});

	it("leaves mixed content on one line, spaces intact", () => {
		// The spaces around `<b>` are part of the paragraph's text. Breaking the
		// children onto their own lines would be editing the document.
		const mixed = "<p>hello <b>x</b> world</p>";
		expect(formatXml(`<doc>${mixed}</doc>`)).toBe(["<doc>", `  ${mixed}`, "</doc>"].join("\n"));
	});

	it("copies a CDATA section through, markup inside it and all", () => {
		const cdata = "<![CDATA[<not><real> & unescaped]]>";
		expect(formatXml(`<a><b>${cdata}</b></a>`)).toBe(
			["<a>", "  <b>", `    ${cdata}`, "  </b>", "</a>"].join("\n")
		);
	});

	it("does not end a tag at a `>` inside an attribute value", () => {
		// The reason the scanner is quote-aware: an unescaped `>` in an attribute
		// is well-formed, and a naive scan would end the tag inside it and take
		// the rest of the document with it.
		expect(formatXml('<a><b q="1 > 0">v</b></a>')).toBe(
			["<a>", '  <b q="1 > 0">v</b>', "</a>"].join("\n")
		);
	});

	it("keeps a comment on its own line without descending into it", () => {
		expect(formatXml("<a><!-- a > b, </not-a-tag> --><b>1</b></a>")).toBe(
			["<a>", "  <!-- a > b, </not-a-tag> -->", "  <b>1</b>", "</a>"].join("\n")
		);
	});

	it("returns empty input as it found it", () => {
		expect(formatXml("")).toBe("");
	});
});
