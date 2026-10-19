/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { receivedHeaderLines, resolveHeaderLines } from "./header-lines";

const LINES = [
	{ name: "X-Dup", value: "a" },
	{ name: "x-dup", value: "b" },
];

describe("receivedHeaderLines", () => {
	it("keeps the lines the engine sent", () => {
		expect(receivedHeaderLines(LINES)).toBe(LINES);
	});

	it("reads an empty list and an absent one as the same nothing", () => {
		expect(receivedHeaderLines([])).toBeUndefined();
		expect(receivedHeaderLines(undefined)).toBeUndefined();
	});
});

describe("resolveHeaderLines", () => {
	it("keeps the engine's lines, repeats and received case included", () => {
		expect(resolveHeaderLines({ "x-dup": "a, b" }, LINES)).toEqual(LINES);
	});

	it("derives one line per folded name when the answer has none", () => {
		expect(
			resolveHeaderLines({ "content-type": "text/plain", server: "x" }, undefined)
		).toEqual([
			{ name: "content-type", value: "text/plain" },
			{ name: "server", value: "x" },
		]);
	});

	it("treats an empty list like an absent one", () => {
		expect(resolveHeaderLines({ server: "x" }, [])).toEqual([{ name: "server", value: "x" }]);
	});

	it("is empty when there is nothing at all", () => {
		expect(resolveHeaderLines({}, [])).toEqual([]);
		expect(resolveHeaderLines(undefined, undefined)).toEqual([]);
	});
});
