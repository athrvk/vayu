/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	encodeAtUrlComponent,
	encodeLiteralAtUrlComponent,
	resolveUrlTemplate,
	type UrlComponent,
} from "./query-encoding";

// The component walk the engine's `advance_url_component` mirrors, read through
// the `where` the encoders return; the substitution outcomes it drives are in
// the conformance fixture.
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
		expect(encodeLiteralAtUrlComponent(text, "head").where).toBe(expected);
	});

	it("reads a kept token as head text, so the / after it opens the path", () => {
		expect(encodeLiteralAtUrlComponent("{{base}}/", "head").where).toBe("path");
		expect(encodeLiteralAtUrlComponent("http://{{host}}/", "head").where).toBe("path");
		// A separator inside the token moves nothing.
		expect(encodeLiteralAtUrlComponent("{{a/b?c#d}}", "head").where).toBe("head");
	});

	it("continues from where the text before it stopped", () => {
		expect(encodeLiteralAtUrlComponent("a/b", "path").where).toBe("path");
		expect(encodeLiteralAtUrlComponent("?x", "path").where).toBe("query");
		expect(encodeLiteralAtUrlComponent("//h/p", "headSeparator").where).toBe("path");
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
