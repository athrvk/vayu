/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `detectBodyType`'s order is its meaning: the first branch a Content-Type
 * matches wins. `image/svg+xml` matches both `image/` and `xml`, and SVG is
 * text the engine sends as text (issue #2458), so the SVG check comes first.
 */

import { describe, expect, it } from "vitest";

import { detectBodyType } from "./utils";

const typed = (contentType: string) => ({ "content-type": contentType });

describe("detectBodyType", () => {
	it("reads SVG as XML before it could read as an image", () => {
		expect(detectBodyType(typed("image/svg+xml"), "<svg/>")).toBe("xml");
		expect(detectBodyType(typed("image/svg+xml; charset=utf-8"), "<svg/>")).toBe("xml");
	});

	it("still reads every other image type as an image", () => {
		expect(detectBodyType(typed("image/png"), "")).toBe("image");
		expect(detectBodyType(typed("image/webp"), "")).toBe("image");
	});

	it("leaves XHTML to the HTML branch", () => {
		expect(detectBodyType(typed("application/xhtml+xml"), "")).toBe("html");
	});
});
