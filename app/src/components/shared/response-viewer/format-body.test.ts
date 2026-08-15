/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Pretty toggle actually does per body type.
 *
 * XML was detected here and highlighted by Monaco but never indented, so Pretty
 * and Raw were byte-identical for every XML response - the toggle looking
 * broken for the SOAP and legacy-enterprise APIs the `xml` body mode (issue
 * #580) serves. The indenter itself is pinned in `lib/xml-format.test.ts`; what
 * is pinned here is the wiring: which body type reaches it, and which must not.
 */

import { describe, it, expect } from "vitest";
import { formatBody } from "./utils";

const DOC = "<a><b>1</b></a>";
const INDENTED = ["<a>", "  <b>1</b>", "</a>"].join("\n");

describe("formatBody", () => {
	// The reported bug. Mutation check: drop the xml branch from `formatBody`
	// and this reddens while every other case here stays green.
	it("indents an XML body", () => {
		expect(formatBody(DOC, "xml")).toBe(INDENTED);
	});

	it("returns malformed XML as it arrived", () => {
		// A truncated response is still something the user has to be able to read.
		const broken = "<a><b>1</b>";
		expect(formatBody(broken, "xml")).toBe(broken);
	});

	it("does not XML-format a body whose type was not declared", () => {
		// Without a type, "starts with a tag" is also true of HTML, whose
		// whitespace rules are not XML's - so the undefined case the JSON branch
		// serves must not fall through to the indenter.
		expect(formatBody(DOC, undefined)).toBe(DOC);
	});

	it.each(["html", "text", "javascript"] as const)("leaves a %s body alone", (bodyType) => {
		expect(formatBody(DOC, bodyType)).toBe(DOC);
	});

	it("still pretty-prints JSON, declared or sniffed", () => {
		expect(formatBody('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
		expect(formatBody('{"a":1}', undefined)).toBe('{\n  "a": 1\n}');
	});

	it("keeps invalid JSON as it arrived", () => {
		expect(formatBody("{oops", "json")).toBe("{oops");
	});

	it("stringifies an already-parsed object", () => {
		expect(formatBody({ a: 1 }, "json")).toBe('{\n  "a": 1\n}');
	});

	it("answers empty for nothing at all", () => {
		expect(formatBody("", "xml")).toBe("");
		expect(formatBody(undefined, "xml")).toBe("");
	});
});
