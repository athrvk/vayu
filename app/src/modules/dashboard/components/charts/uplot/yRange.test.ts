/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The y range a chart's scale is given. Pure, so it is driven directly: a chart
 * in jsdom has no layout to read an axis from.
 */

import { describe, it, expect } from "vitest";
import type uPlot from "uplot";
import { baseRange, rangeFrom } from "./yRange";

describe("baseRange", () => {
	it("starts at the base, with headroom above the tallest point", () => {
		expect(baseRange(0, 480, 520)).toEqual([0, 572]);
	});

	it("does not collapse the axis for an all-zero series", () => {
		const [lo, hi] = baseRange(0, 0, 0);
		expect(lo).toBe(0);
		expect(hi).toBeGreaterThan(lo);
	});

	it("does not collapse the axis for a flat non-zero series", () => {
		const [lo, hi] = baseRange(0, 7, 7);
		expect(lo).toBe(0);
		expect(hi).toBeGreaterThan(7);
	});

	it("gives an empty chart a unit of span from the base", () => {
		expect(baseRange(0, null, null)).toEqual([0, 1]);
		expect(baseRange(0, undefined, undefined)).toEqual([0, 1]);
		expect(baseRange(0, Infinity, -Infinity)).toEqual([0, 1]);
	});

	it("moves the floor under data below the base instead of clipping it", () => {
		const [lo, hi] = baseRange(0, -30, 10);
		expect(lo).toBeLessThan(-30);
		expect(hi).toBeGreaterThan(10);
	});

	it("keeps the axis open for a flat series below the base", () => {
		const [lo, hi] = baseRange(0, -5, -5);
		expect(lo).toBeLessThan(-5);
		expect(hi).toBeGreaterThan(-5);
	});

	it("honours a base other than zero", () => {
		expect(baseRange(100, 150, 200)).toEqual([100, 210]);
	});
});

describe("rangeFrom", () => {
	const u = {} as uPlot;

	it("opts out with null, leaving uPlot's auto-range in charge", () => {
		expect(rangeFrom(null)).toBeUndefined();
	});

	it("returns a range function pinned to the base", () => {
		const range = rangeFrom(0);
		expect(range?.(u, 480, 520, "y")).toEqual([0, 572]);
	});
});
