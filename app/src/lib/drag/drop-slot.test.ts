/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The slot arithmetic a drop is decided by.
 *
 * Node environment: positions in, indices out, no DOM. The off-by-one that
 * matters is `landingIndex` - a slot after the dragged item counts the item's
 * own old place, so it lands one lower.
 */

import { describe, it, expect } from "vitest";
import { isNoOpSlot, landingIndex, slotAt } from "./drop-slot";

const THREE_ITEMS = [
	{ start: 0, end: 100 },
	{ start: 100, end: 200 },
	{ start: 200, end: 300 },
];

describe("slotAt", () => {
	it("is the number of items whose midpoint is before the pointer", () => {
		expect(slotAt(THREE_ITEMS, 10)).toBe(0);
		expect(slotAt(THREE_ITEMS, 60)).toBe(1);
		expect(slotAt(THREE_ITEMS, 160)).toBe(2);
		expect(slotAt(THREE_ITEMS, 310)).toBe(3);
	});

	it("puts a pointer exactly on a midpoint in the earlier slot", () => {
		expect(slotAt(THREE_ITEMS, 50)).toBe(0);
		expect(slotAt(THREE_ITEMS, 150)).toBe(1);
	});

	it("is slot 0 for an empty list", () => {
		expect(slotAt([], 120)).toBe(0);
	});

	it("refuses a coordinate that is not a number", () => {
		expect(() => slotAt(THREE_ITEMS, Number.NaN)).toThrow(/finite/);
		expect(() => slotAt(THREE_ITEMS, Number.POSITIVE_INFINITY)).toThrow(/finite/);
	});
});

describe("landingIndex", () => {
	it("drops by one when the slot is after the item's old place", () => {
		expect(landingIndex(2, 0)).toBe(1);
		expect(landingIndex(3, 0)).toBe(2);
	});

	it("keeps the slot when it is at or before the item's old place", () => {
		expect(landingIndex(0, 2)).toBe(0);
		expect(landingIndex(1, 2)).toBe(1);
		expect(landingIndex(2, 2)).toBe(2);
	});

	it("refuses a slot or source that is not a non-negative integer", () => {
		expect(() => landingIndex(1.5, 0)).toThrow(/integer/);
		expect(() => landingIndex(1, -1)).toThrow(/integer/);
		expect(() => landingIndex(-1, 0)).toThrow(/integer/);
	});
});

describe("isNoOpSlot", () => {
	it("is true only for the slots just before and just after the item", () => {
		for (const from of [0, 1, 4]) {
			expect(isNoOpSlot(from, from)).toBe(true);
			expect(isNoOpSlot(from + 1, from)).toBe(true);
			expect(isNoOpSlot(from + 2, from)).toBe(false);
			if (from > 0) expect(isNoOpSlot(from - 1, from)).toBe(false);
		}
	});

	it("refuses a slot or source that is not a non-negative integer", () => {
		expect(() => isNoOpSlot(0.5, 0)).toThrow(/integer/);
		expect(() => isNoOpSlot(0, -1)).toThrow(/integer/);
	});
});
