/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many document tabs fit, and how wide each one wants to be.
 *
 * The strip sizes each tab to its own name and sends the rest to an overflow
 * menu. It used to do the opposite - `min-w-20 max-w-50 shrink` let all of them
 * compress together, so opening a ninth tab made the other eight worse and the
 * platform decided readability: the same eight tabs degraded differently on
 * macOS, Windows and Linux because each leaves a different amount of strip.
 *
 * Widths are measured with a canvas rather than from the DOM. Measuring rendered
 * tabs is circular here - deciding to hide one changes the widths you would
 * measure next - and a canvas needs no layout pass, so the answer is stable and
 * this file stays a pure function worth unit-testing.
 */

import {
	TAB_MIN_WIDTH,
	TAB_MAX_WIDTH,
	TAB_OVERFLOW_WIDTH,
	TAB_NEW_BUTTON_WIDTH,
} from "@/constants/layout";

/**
 * Everything a tab draws that is not the name, in px.
 *
 * 8px leading padding, 10px trailing, a 2px method rail, a 1px separator, and
 * 6px of gap when an icon is present. The close button is absolutely positioned
 * over the trailing padding, so unlike the old strip it costs nothing here -
 * that alone was 22px on every tab, reserved for a control shown on one.
 */
export const TAB_CHROME = 8 + 10 + 2 + 1;
/** Extra when the tab carries a type icon (collection, run, settings…). */
export const TAB_ICON_SPACE = 12 + 6;

export interface TabMetrics {
	/** Text that will be drawn as the tab's name. */
	label: string;
	/** Whether the tab draws a leading type icon. */
	hasIcon: boolean;
}

/** Measures text at the strip's own computed font, so zoom and the user's font choice are included. */
export function makeTextMeasurer(font: string): (text: string) => number {
	let ctx: CanvasRenderingContext2D | null = null;
	try {
		ctx = document.createElement("canvas").getContext("2d");
	} catch {
		ctx = null;
	}
	if (!ctx) {
		// No canvas (jsdom, or a locked-down environment). Estimate rather than
		// collapse every tab to zero width, which would hide the whole strip.
		return (text) => text.length * 7.3;
	}
	ctx.font = font;
	return (text) => ctx.measureText(text).width;
}

/** The width a tab wants: its name plus chrome, clamped to the configured bounds. */
export function naturalTabWidth(tab: TabMetrics, measure: (text: string) => number): number {
	const content = TAB_CHROME + (tab.hasIcon ? TAB_ICON_SPACE : 0) + measure(tab.label);
	return Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, Math.ceil(content)));
}

export interface FitResult {
	/** Indices of the tabs to render, in strip order. */
	visible: number[];
	/** Indices that did not fit, in strip order. */
	overflowed: number[];
}

/**
 * Decide which tabs are shown.
 *
 * Two rules that are easy to get wrong:
 *
 * - The overflow control's width is reserved *before* choosing how many tabs to
 *   show, not after. Fitting one more tab and then finding nowhere to put the
 *   "+3" is how a strip hides tabs with no way to reach them.
 * - **The active tab is never overflowed.** Picking a tab from the menu has to
 *   put it on screen, or the menu looks like it did nothing.
 */
export function fitTabs(widths: number[], availableWidth: number, activeIndex: number): FitResult {
	const all = widths.map((_, i) => i);
	const room = availableWidth - TAB_NEW_BUTTON_WIDTH;
	// Before the first measurement `availableWidth` is 0. Show everything rather
	// than nothing: one frame of a too-wide strip is clipped, whereas one frame
	// of an empty strip is a flash of missing UI.
	if (widths.length === 0 || room <= 0) return { visible: all, overflowed: [] };

	const total = widths.reduce((a, b) => a + b, 0);
	if (total <= room) return { visible: all, overflowed: [] };

	// Something must overflow, so the control has to be paid for.
	const budget = room - TAB_OVERFLOW_WIDTH;
	const shown: number[] = [];
	let used = 0;

	// The active tab is placed first so it can never be the one pushed out, then
	// the rest fill in strip order around it.
	if (activeIndex >= 0 && activeIndex < widths.length) {
		shown.push(activeIndex);
		used = widths[activeIndex];
	}
	for (let i = 0; i < widths.length; i++) {
		if (i === activeIndex) continue;
		if (used + widths[i] > budget) continue;
		shown.push(i);
		used += widths[i];
	}

	shown.sort((a, b) => a - b);
	const visible = new Set(shown);
	return { visible: shown, overflowed: all.filter((i) => !visible.has(i)) };
}
