/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Windows taskbar overlay's two images (#1364).
 *
 * The point of drawing them rather than shipping them is that the drawing can be
 * read back, so these cases read pixels: a disc that reaches the edges, a
 * transparent corner outside it, and ink where the glyph says there is ink.
 * Nothing here looks at a taskbar, which is exactly why it can run in CI.
 */

import { describe, it, expect } from "vitest";
import {
	countOverlayBitmap,
	failedOverlayBitmap,
	overlayCountText,
	OVERLAY_MAX_COUNT,
	OVERLAY_SIZE,
	type Bitmap,
} from "./os-icon-overlay";

/** One pixel, unpacked from the BGRA `nativeImage.createFromBitmap` wants. */
function pixel(bitmap: Bitmap, x: number, y: number) {
	const offset = (y * bitmap.width + x) * 4;
	return {
		b: bitmap.data[offset],
		g: bitmap.data[offset + 1],
		r: bitmap.data[offset + 2],
		a: bitmap.data[offset + 3],
	};
}

/**
 * A point inside the disc that no glyph reaches: the glyphs are centred on a
 * 15-pixel band, and this sits above it.
 */
const ABOVE_THE_GLYPHS = { x: 16, y: 3 };

/** Ink of the `1` glyph's bottom bar, derived from the layout in the module. */
const INSIDE_THE_ONE = { x: 13, y: 22 };

describe("overlayCountText", () => {
	it("says the count itself up to the cap", () => {
		expect(overlayCountText(1)).toBe("1");
		expect(overlayCountText(OVERLAY_MAX_COUNT)).toBe(String(OVERLAY_MAX_COUNT));
	});

	it("gives up exactly once past the cap", () => {
		expect(overlayCountText(OVERLAY_MAX_COUNT + 1)).toBe(`${OVERLAY_MAX_COUNT}+`);
		expect(overlayCountText(400)).toBe(`${OVERLAY_MAX_COUNT}+`);
	});

	it("says nothing for a count with nothing to say", () => {
		for (const count of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(overlayCountText(count), String(count)).toBe("");
		}
	});
});

describe("countOverlayBitmap", () => {
	/*
	 * Mutation check: return an empty disc for zero instead of null and this
	 * reddens - which is the bug it guards, a red dot on the taskbar meaning
	 * "no unread captures".
	 */
	it("draws nothing at all for a count of zero", () => {
		expect(countOverlayBitmap(0)).toBeNull();
	});

	it("is the size the caller hands back at scale 2", () => {
		const bitmap = countOverlayBitmap(1);
		expect(bitmap).not.toBeNull();
		expect(bitmap?.width).toBe(OVERLAY_SIZE);
		expect(bitmap?.height).toBe(OVERLAY_SIZE);
		expect(bitmap?.data.length).toBe(OVERLAY_SIZE * OVERLAY_SIZE * 4);
	});

	it("fills a disc, and leaves the corner outside it transparent", () => {
		const bitmap = countOverlayBitmap(1);
		if (!bitmap) throw new Error("a count of 1 draws something");
		expect(pixel(bitmap, ABOVE_THE_GLYPHS.x, ABOVE_THE_GLYPHS.y).a).toBe(255);
		expect(pixel(bitmap, ABOVE_THE_GLYPHS.x, ABOVE_THE_GLYPHS.y).r).toBeGreaterThan(
			pixel(bitmap, ABOVE_THE_GLYPHS.x, ABOVE_THE_GLYPHS.y).b
		);
		expect(pixel(bitmap, 0, 0).a).toBe(0);
		expect(pixel(bitmap, OVERLAY_SIZE - 1, OVERLAY_SIZE - 1).a).toBe(0);
	});

	it("draws the glyph in white on top of the disc", () => {
		const bitmap = countOverlayBitmap(1);
		if (!bitmap) throw new Error("a count of 1 draws something");
		expect(pixel(bitmap, INSIDE_THE_ONE.x, INSIDE_THE_ONE.y)).toEqual({
			r: 255,
			g: 255,
			b: 255,
			a: 255,
		});
	});

	/*
	 * Mutation check: drop the `9+` branch in `overlayCountText` and a count of
	 * ten draws two digits, which do not fit the disc - this compares against
	 * the picture `9+` makes rather than trusting the string alone.
	 */
	it("draws the same picture for every count past the cap", () => {
		const ten = countOverlayBitmap(OVERLAY_MAX_COUNT + 1);
		const hundred = countOverlayBitmap(100);
		expect(ten?.data).toEqual(hundred?.data);
		expect(ten?.data).not.toEqual(countOverlayBitmap(OVERLAY_MAX_COUNT)?.data);
	});
});

describe("failedOverlayBitmap", () => {
	/*
	 * The two marks share one Windows surface, so telling them apart is the
	 * whole of what this image is for.
	 */
	it("is not the same picture as any count", () => {
		const failed = failedOverlayBitmap();
		for (const count of [1, OVERLAY_MAX_COUNT, OVERLAY_MAX_COUNT + 1]) {
			expect(failed.data, `count ${count}`).not.toEqual(countOverlayBitmap(count)?.data);
		}
	});

	it("fills the same disc, so the two marks read as one family", () => {
		const failed = failedOverlayBitmap();
		expect(pixel(failed, ABOVE_THE_GLYPHS.x, ABOVE_THE_GLYPHS.y).a).toBe(255);
		expect(pixel(failed, 0, 0).a).toBe(0);
	});
});
