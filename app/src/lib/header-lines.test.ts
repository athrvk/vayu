/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import {
	headerLinesOf,
	receivedHeaderLines,
	resolveHeaderLines,
	sentHeaderLines,
} from "./header-lines";

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

describe("sentHeaderLines (issue #2466)", () => {
	it("keeps the lines the engine sent and reads an empty list as an absent one", () => {
		expect(sentHeaderLines(LINES)).toBe(LINES);
		expect(sentHeaderLines([])).toBeUndefined();
		expect(sentHeaderLines(undefined)).toBeUndefined();
	});
});

describe("headerLinesOf (issue #2466)", () => {
	it("passes the ordered lines through, a repeat kept", () => {
		expect(headerLinesOf(LINES)).toEqual(LINES);
	});

	it("reads the older record as one line per key, in key order", () => {
		expect(headerLinesOf({ Zeta: "z", Alpha: "a" })).toEqual([
			{ name: "Zeta", value: "z" },
			{ name: "Alpha", value: "a" },
		]);
	});

	it("reads an absent payload as no lines", () => {
		expect(headerLinesOf(undefined)).toEqual([]);
	});
});
