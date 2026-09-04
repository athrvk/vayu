/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The strip's sizing rule, tested away from the DOM.
 *
 * This is the whole behavioural change to the tab strip: it stops compressing
 * every tab to fit and starts overflowing instead. The two rules that make it
 * safe rather than merely different - reserving the overflow control before
 * choosing, and never overflowing the active tab - are both invisible in a
 * screenshot and both easy to regress, so they are pinned here.
 */

import { describe, it, expect } from "vitest";
import { fitTabs, naturalTabWidth, TAB_CHROME, TAB_CLOSE_SPACE, TAB_ICON_SPACE } from "./tab-fit";
import {
	TAB_MIN_WIDTH,
	TAB_MAX_WIDTH,
	TAB_OVERFLOW_WIDTH,
	TAB_NEW_BUTTON_WIDTH,
} from "@/constants/layout";

/** 10px a character, so the arithmetic in each case is readable. */
const measure = (s: string) => s.length * 10;

describe("naturalTabWidth", () => {
	it("sizes to the label plus chrome", () => {
		expect(naturalTabWidth({ label: "abcdefghij", hasIcon: false }, measure)).toBe(
			TAB_CHROME + 100
		);
	});

	it("leaves the close button a strip the name cannot reach", () => {
		// The button is absolutely positioned, which takes it out of layout and
		// not out of the way: budget it at 0 and the name of an active tab runs
		// under it (#1202). Drop TAB_TRAILING back to the old 10px and this reds.
		const label = "abcdefghij";
		const width = naturalTabWidth({ label, hasIcon: false }, measure);
		const trailing = width - measure(label) - 8 - 2 - 1;
		expect(trailing).toBeGreaterThanOrEqual(TAB_CLOSE_SPACE);
	});

	it("charges for a type icon only when there is one", () => {
		const withIcon = naturalTabWidth({ label: "abcdefghij", hasIcon: true }, measure);
		const without = naturalTabWidth({ label: "abcdefghij", hasIcon: false }, measure);
		expect(withIcon - without).toBe(TAB_ICON_SPACE);
	});

	it("clamps to the configured bounds", () => {
		expect(naturalTabWidth({ label: "a", hasIcon: false }, measure)).toBe(TAB_MIN_WIDTH);
		expect(naturalTabWidth({ label: "x".repeat(200), hasIcon: false }, measure)).toBe(
			TAB_MAX_WIDTH
		);
	});
});

describe("fitTabs", () => {
	it("shows everything when it all fits", () => {
		const w = [100, 100, 100];
		const r = fitTabs(w, 400 + TAB_NEW_BUTTON_WIDTH, 0);
		expect(r.visible).toEqual([0, 1, 2]);
		expect(r.overflowed).toEqual([]);
	});

	it("reserves the overflow control before choosing, not after", () => {
		// 300px of tabs into a room of exactly 250 + the new-tab button. Two tabs
		// (200) would fit the raw room, but not once the "+N" is paid for, so only
		// one is shown. Getting this backwards is how a strip hides a tab and then
		// has nowhere to put the control that reaches it.
		const w = [100, 100, 100];
		const room = 250;
		const r = fitTabs(w, room + TAB_NEW_BUTTON_WIDTH, 0);
		const budget = room - TAB_OVERFLOW_WIDTH; // 194
		expect(r.visible.length).toBe(Math.floor(budget / 100));
		expect(r.overflowed.length).toBe(3 - r.visible.length);
	});

	it("never overflows the active tab, even when it is last", () => {
		// Picking a tab from the overflow menu has to put it on screen. If the
		// active tab can be overflowed, selecting one appears to do nothing.
		const w = [100, 100, 100, 100, 100];
		const r = fitTabs(w, 260 + TAB_NEW_BUTTON_WIDTH, 4);
		expect(r.visible).toContain(4);
		expect(r.overflowed).not.toContain(4);
	});

	it("keeps the visible tabs in strip order", () => {
		// The active tab is placed first internally so it cannot be squeezed out;
		// that must not reorder the strip.
		const w = [100, 100, 100, 100];
		const r = fitTabs(w, 260 + TAB_NEW_BUTTON_WIDTH, 3);
		expect([...r.visible]).toEqual([...r.visible].sort((a, b) => a - b));
	});

	it("accounts for every tab exactly once", () => {
		const w = [90, 150, 220, 100, 130, 90];
		for (const room of [0, 120, 300, 500, 2000]) {
			const r = fitTabs(w, room, 2);
			expect([...r.visible, ...r.overflowed].sort((a, b) => a - b)).toEqual([
				0, 1, 2, 3, 4, 5,
			]);
		}
	});

	it("shows everything before the first measurement rather than nothing", () => {
		// availableWidth is 0 on the first render. An empty strip for a frame reads
		// as broken UI; a clipped one reads as still laying out.
		const r = fitTabs([100, 100], 0, 0);
		expect(r.visible).toEqual([0, 1]);
		expect(r.overflowed).toEqual([]);
	});

	it("handles an empty strip", () => {
		expect(fitTabs([], 800, -1)).toEqual({ visible: [], overflowed: [] });
	});
});
