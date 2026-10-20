/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { mountedSegments, nearestScrollTop, rowAt, rowOffsets, visibleRange } from "./tree-window";

/** A folder, then requests half a unit apart: the tree's own pitch. */
const strides = [8, 9, 8.5, 8.5, 8.5, 8.5];
const offsets = rowOffsets(strides);

describe("rowOffsets", () => {
	it("is a prefix sum, ending at the list's height", () => {
		expect(offsets).toEqual([0, 8, 17, 25.5, 34, 42.5, 51]);
	});
});

describe("rowAt", () => {
	it("finds the row whose stride holds a point, edges included", () => {
		expect(rowAt(offsets, 0)).toBe(0);
		expect(rowAt(offsets, 7.9)).toBe(0);
		expect(rowAt(offsets, 8)).toBe(1);
		expect(rowAt(offsets, 30)).toBe(3);
	});

	it("clamps to the list", () => {
		expect(rowAt(offsets, -5)).toBe(0);
		expect(rowAt(offsets, 1000)).toBe(strides.length - 1);
		expect(rowAt([0], 3)).toBe(-1);
	});
});

describe("visibleRange", () => {
	it("covers the viewport and the overscan on either side", () => {
		expect(visibleRange(offsets, 17, 10, 0)).toEqual({ start: 2, end: 4 });
		expect(visibleRange(offsets, 17, 10, 1)).toEqual({ start: 1, end: 5 });
	});

	it("never runs past either end", () => {
		expect(visibleRange(offsets, 0, 1000, 10)).toEqual({ start: 0, end: strides.length });
		expect(visibleRange([0], 0, 10, 2)).toEqual({ start: 0, end: 0 });
	});
});

describe("mountedSegments", () => {
	it("is one run of rows when the range is the whole list", () => {
		expect(mountedSegments(6, { start: 0, end: 6 }, [])).toEqual([
			{ kind: "rows", start: 0, end: 6 },
		]);
	});

	it("puts a gap on each side of the range", () => {
		expect(mountedSegments(10, { start: 3, end: 6 }, [])).toEqual([
			{ kind: "gap", start: 0, end: 3 },
			{ kind: "rows", start: 3, end: 6 },
			{ kind: "gap", start: 6, end: 10 },
		]);
	});

	it("mounts a pinned row far away as a run of its own, in order", () => {
		expect(mountedSegments(20, { start: 10, end: 13 }, [17, 1])).toEqual([
			{ kind: "gap", start: 0, end: 1 },
			{ kind: "rows", start: 1, end: 2 },
			{ kind: "gap", start: 2, end: 10 },
			{ kind: "rows", start: 10, end: 13 },
			{ kind: "gap", start: 13, end: 17 },
			{ kind: "rows", start: 17, end: 18 },
			{ kind: "gap", start: 18, end: 20 },
		]);
	});

	it("joins a pinned row that touches or sits inside the range", () => {
		expect(mountedSegments(10, { start: 3, end: 6 }, [6, 4, 2])).toEqual([
			{ kind: "gap", start: 0, end: 2 },
			{ kind: "rows", start: 2, end: 7 },
			{ kind: "gap", start: 7, end: 10 },
		]);
	});

	it("ignores a pinned index outside the list", () => {
		expect(mountedSegments(4, { start: 0, end: 2 }, [-1, 9])).toEqual([
			{ kind: "rows", start: 0, end: 2 },
			{ kind: "gap", start: 2, end: 4 },
		]);
	});
});

describe("nearestScrollTop", () => {
	it("stays put for a span already in view", () => {
		expect(nearestScrollTop(100, 300, 150, 182)).toBe(100);
	});

	it("aligns the top edge of a span above the view", () => {
		expect(nearestScrollTop(100, 300, 40, 72)).toBe(40);
	});

	it("aligns the bottom edge of a span below the view", () => {
		expect(nearestScrollTop(100, 300, 500, 532)).toBe(232);
	});

	it("shows the top of a span taller than the view", () => {
		expect(nearestScrollTop(0, 30, 500, 600)).toBe(500);
	});
});
