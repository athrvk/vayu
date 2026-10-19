/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { advanceUrlComponent, type UrlComponent } from "./query-encoding";

// The component walk the engine's `advance_url_component` pins; the
// substitution outcomes it drives are in the conformance fixture.
describe("advanceUrlComponent", () => {
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
});
