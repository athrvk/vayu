/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	advanceUrlComponent,
	encodeAtUrlComponent,
	encodeUrlAsPostman,
	resolveUrlTemplate,
	type UrlComponent,
} from "./query-encoding";

// The component walk the engine's `advance_url_component` mirrors; the
// substitution outcomes it drives are in the conformance fixture.
describe("the URL component walk", () => {
	it.each<[string, string, UrlComponent]>([
		["a bare host", "example.com", "head"],
		["the // after the scheme", "http://", "headSeparator"],
		["the host after the scheme", "http://h", "head"],
		["the first / after the host", "http://h/", "path"],
		["a port, then the path", "h:8080/p", "path"],
		["a ? in the path", "http://h/p?q", "query"],
		["a ? in the head", "http://h?q", "query"],
		["a ? in the query", "http://h/p?q=a?b", "query"],
		["a # in the query", "http://h/p?q=a#f", "fragment"],
		["a / in the fragment", "http://h/p#f/g?h", "fragment"],
	])("%s", (_name, text, expected) => {
		expect(advanceUrlComponent(text, "head")).toBe(expected);
	});

	it("reads a kept token as head text, so the / after it opens the path", () => {
		expect(advanceUrlComponent("{{base}}/", "head")).toBe("path");
		expect(advanceUrlComponent("http://{{host}}/", "head")).toBe("path");
		// A separator inside the token moves nothing.
		expect(advanceUrlComponent("{{a/b?c#d}}", "head")).toBe("head");
	});

	it("continues from where the text before it stopped", () => {
		expect(advanceUrlComponent("a/b", "path")).toBe("path");
		expect(advanceUrlComponent("?x", "path")).toBe("query");
		expect(advanceUrlComponent("//h/p", "headSeparator")).toBe("path");
	});

	it("walks a substituted value the same way", () => {
		expect(encodeAtUrlComponent("h/p", "head").where).toBe("path");
		expect(encodeAtUrlComponent("a?b", "path").where).toBe("query");
		expect(encodeAtUrlComponent("a#b", "query").where).toBe("fragment");
	});

	it("encodes each substituted value by the component the text before it reached", () => {
		const values: Record<string, string> = {
			"{{h}}": "x y",
			"{{v}}": "a b{c}",
			"{{w}}": "a'b",
		};
		const resolve = (token: string) => values[token] ?? token;
		expect(resolveUrlTemplate("http://{{h}}/p/{{v}}?q={{w}}", resolve, { encode: true })).toBe(
			"http://x y/p/a%20b%7Bc%7D?q=a%27b"
		);
	});
});

// The whole-URL writer (issue #2465); every byte-level case is in the
// conformance fixture, these pin the seams the fixture does not name.
describe("encodeUrlAsPostman", () => {
	it("writes each component by its set and leaves an escape alone", () => {
		expect(encodeUrlAsPostman("http://h/a b?q=a b#f g")).toBe("http://h/a%20b?q=a%20b#f%20g");
		expect(encodeUrlAsPostman("http://h/a%20b?q=a%2Fb")).toBe("http://h/a%20b?q=a%2Fb");
	});

	it("is idempotent", () => {
		const once = encodeUrlAsPostman("  HTTP://u s:p@Bücher.de\\a b?x=é&y=z#é");
		expect(encodeUrlAsPostman(once)).toBe(once);
	});

	it("lowercases the host and punycodes a non-ASCII one, keeping the scheme and the port", () => {
		expect(encodeUrlAsPostman("HTTP://Bücher.DE:8080/Ä")).toBe(
			"HTTP://xn--bcher-kva.de:8080/%C3%84"
		);
	});

	it("keeps a host with no ASCII name as typed", () => {
		expect(encodeUrlAsPostman("http://é</x")).toBe("http://é</x");
	});

	it("keeps a bracketed IPv6 literal and lowercases it", () => {
		expect(encodeUrlAsPostman("http://[FE80::1]:80/")).toBe("http://[fe80::1]:80/");
	});

	it("reads user info up to the last @ in the authority", () => {
		expect(encodeUrlAsPostman("http://a@b:c d@H/p")).toBe("http://a%40b:c%20d@h/p");
	});

	it("keeps a file URL's third slash and writes a head backslash as /", () => {
		expect(encodeUrlAsPostman("file:///a b")).toBe("file:///a%20b");
		expect(encodeUrlAsPostman("http:\\\\h\\a?q=\\")).toBe("http://h/a?q=\\");
	});

	it("leaves a {{token}} alone wherever it sits", () => {
		expect(encodeUrlAsPostman("{{Base}}/{{p q}}?{{k=1}}={{v w}}#{{f g}}")).toBe(
			"{{Base}}/{{p q}}?{{k=1}}={{v w}}#{{f g}}"
		);
		expect(encodeUrlAsPostman("http://{{H}}:{{P}}/a b")).toBe("http://{{H}}:{{P}}/a%20b");
	});

	it("splits the query at the first = of each pair and keeps a bare key", () => {
		expect(encodeUrlAsPostman("http://h/?a=b=c&d&e=")).toBe("http://h/?a=b=c&d&e=");
		expect(encodeUrlAsPostman("http://h/?a b&c d=e f")).toBe("http://h/?a%20b&c%20d=e%20f");
	});

	it("answers an empty string for whitespace alone", () => {
		expect(encodeUrlAsPostman(" \t\n")).toBe("");
	});
});

describe("resolveUrlTemplate", () => {
	const resolve = (text: string) => text.replace(/{{h}}/g, "Ex Ample.COM");

	it("writes the literals raw, then encodes the whole URL", () => {
		expect(resolveUrlTemplate("HTTP://{{h}}/a b?q=a'b", resolve, { encode: true })).toBe(
			"HTTP://ex ample.com/a%20b?q=a%27b"
		);
	});

	it("writes the URL as typed under disableUrlEncoding, host and backslash included", () => {
		expect(resolveUrlTemplate("HTTP://{{h}}\\a b?q=a'b", resolve, { encode: false })).toBe(
			"HTTP://Ex Ample.COM\\a b?q=a'b"
		);
	});

	it("leaves an unresolved token verbatim for a snippet", () => {
		expect(resolveUrlTemplate("{{base}}/a b/{{id}}", (token) => token, { encode: true })).toBe(
			"{{base}}/a%20b/{{id}}"
		);
	});
});
