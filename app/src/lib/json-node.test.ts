/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { asRecord, asStr, prop } from "./json-node";

describe("asRecord", () => {
	it("accepts a plain object", () => {
		const node = { a: 1 };
		expect(asRecord(node)).toBe(node);
	});

	// An array is the shape that makes this worth a helper: `typeof [] === "object"`,
	// so the obvious check lets one through and `node.key` reads undefined forever.
	it("rejects an array, null and scalars", () => {
		expect(asRecord([1, 2])).toBeUndefined();
		expect(asRecord(null)).toBeUndefined();
		expect(asRecord(undefined)).toBeUndefined();
		expect(asRecord("{}")).toBeUndefined();
		expect(asRecord(7)).toBeUndefined();
	});
});

describe("asStr", () => {
	it("returns only a real string - it never coerces", () => {
		expect(asStr("x")).toBe("x");
		expect(asStr("")).toBe("");
		expect(asStr(3)).toBeUndefined();
		expect(asStr(null)).toBeUndefined();
		expect(asStr({ toString: () => "x" })).toBeUndefined();
	});
});

describe("prop", () => {
	it("reads a key off an object node", () => {
		expect(prop({ a: { b: 1 } }, "a")).toEqual({ b: 1 });
	});

	it("is undefined for a missing key or a non-object holder", () => {
		expect(prop({ a: 1 }, "b")).toBeUndefined();
		expect(prop(null, "a")).toBeUndefined();
		expect(prop("string", "length")).toBeUndefined();
		expect(prop([1, 2], "0")).toBeUndefined();
	});

	it("nests, which is the point - a foreign doc may miss any hop", () => {
		expect(asStr(prop(prop({ script: { exec: "code" } }, "script"), "exec"))).toBe("code");
		expect(asStr(prop(prop({ script: "oops" }, "script"), "exec"))).toBeUndefined();
	});
});
