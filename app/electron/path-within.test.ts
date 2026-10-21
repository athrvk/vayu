/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { isWithin } from "./path-within";

describe("isWithin", () => {
	it("admits the root itself and what sits beneath it", () => {
		expect(isWithin("/a/b", "/a/b")).toBe(true);
		expect(isWithin("/a/b", "/a/b/c/d.bin")).toBe(true);
	});

	it("refuses a sibling that shares the root's prefix, and a parent", () => {
		expect(isWithin("/a/b", "/a/bc")).toBe(false);
		expect(isWithin("/a/b", "/a")).toBe(false);
		expect(isWithin("/a/b", "/a/b/../c")).toBe(false);
	});
});
