/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { elementOriginLabel, elementRowKey } from "./element-origin";

describe("elementOriginLabel (issue #3051)", () => {
	it("names the collection an inherited element came from", () => {
		expect(elementOriginLabel({ kind: "collection", name: "Billing" })).toBe('from "Billing"');
	});

	it("still says it was inherited when the collection has no name", () => {
		expect(elementOriginLabel({ kind: "collection" })).toBe("from a collection");
	});

	it.each([
		["a request's own element", { kind: "request" as const, name: "Log in" }],
		["an inline send with no origin", undefined],
	])("prints nothing for %s", (_label, origin) => {
		expect(elementOriginLabel(origin)).toBeUndefined();
	});

	it("never says Folder for a folder-level element", () => {
		expect(elementOriginLabel({ kind: "collection", scope: "folder" })).toBe(
			"from a collection"
		);
	});
});

describe("elementRowKey (issue #3101)", () => {
	it("tells apart two levels' elements under one id", () => {
		const collection = elementRowKey(
			{ id: "el_1", origin: { kind: "collection", scope: "collection", id: "col_1" } },
			0
		);
		const request = elementRowKey(
			{ id: "el_1", origin: { kind: "request", scope: "request", id: "req_1" } },
			1
		);
		expect(collection).not.toBe(request);
	});

	it("falls back to the position for a row with no origin", () => {
		expect(elementRowKey({ id: "el_1" }, 0)).not.toBe(elementRowKey({ id: "el_1" }, 1));
	});
});
