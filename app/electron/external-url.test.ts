/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { isBrowsableUrl, urlProtocol } from "./external-url.js";

describe("isBrowsableUrl", () => {
	it("accepts the two schemes a browser answers for", () => {
		expect(isBrowsableUrl("https://example.com")).toBe(true);
		expect(isBrowsableUrl("http://localhost:9876/health")).toBe(true);
	});

	it("refuses everything else, including what the OS would happily launch", () => {
		expect(isBrowsableUrl("file:///etc/passwd")).toBe(false);
		expect(isBrowsableUrl("vayu://open")).toBe(false);
		expect(isBrowsableUrl("javascript:alert(1)")).toBe(false);
		expect(isBrowsableUrl("mailto:someone@example.com")).toBe(false);
	});

	it("refuses text that is not a URL at all", () => {
		expect(isBrowsableUrl("not a url")).toBe(false);
		expect(isBrowsableUrl("")).toBe(false);
	});
});

describe("urlProtocol", () => {
	it("names the scheme, so a caller can say which one it refused", () => {
		expect(urlProtocol("vayu://open")).toBe("vayu:");
		expect(urlProtocol("https://example.com")).toBe("https:");
	});

	it("answers null for text that does not parse, which is not a scheme", () => {
		expect(urlProtocol("not a url")).toBeNull();
	});
});
