/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many document tabs fit, and how wide each wants to be: the strip sizes each tab to its own
 * name and sends the rest to an overflow menu. Widths come from a canvas, not the DOM: measuring
 * rendered tabs is circular here (hiding one changes the widths measured next), and a canvas needs
 * no layout pass, so the answer is stable and this file stays a pure function worth unit-testing.
 */

import {
	TAB_MIN_WIDTH,
	TAB_MAX_WIDTH,
	TAB_OVERFLOW_WIDTH,
	TAB_NEW_BUTTON_WIDTH,
} from "@/constants/layout";

/**
 * The close button's footprint at the trailing edge: a 24px `size-target` hit box (#1679; a 16px
 * target is under the WCAG 2.2 SC 2.5.8 floor), offset 2px from the edge (`TabStrip.tsx`). The
 * glyph inside stays 12px (`size-icon-sm`); only the hit area grew.
 */
export const TAB_CLOSE_SPACE = 2 + 24;

/** What the name must stop short of at the trailing edge: the button, and air. */
export const TAB_TRAILING = TAB_CLOSE_SPACE + 2;

/**
 * Everything a tab draws that is not the name, in px: 12px leading padding (`px-3`, #1679), the
 * trailing strip above, a 2px method rail, a 1px separator, and 6px of gap when an icon is present.
 * These are Comfortable-density pixels (`--spacing` at 0.25rem/unit): `px-3` is 12px there and 9px
 * at Default, the close button's `right-0.5` 2px there and 1.5px at Default. The constant does not
 * vary by density, so the larger numbers are the safe direction to be wrong in: a few spare px at
 * Default rather than text running under the close button. The trailing strip is that button's
 * footprint plus air: the button is absolutely positioned, out of layout but not out of the way, so
 * a name filling its tab would run under it on every active tab (#1202).
 */
export const TAB_CHROME = 12 + TAB_TRAILING + 2 + 1;
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

/**
 * What a Radix `TabsTrigger` draws that is not its name: `px-2` on both sides, plus the 2px
 * `gap-0.5` the list puts between triggers, so a trigger's width is also its slot in the row.
 * Comfortable-density pixels, the safe direction to be wrong in (see `TAB_CHROME`).
 */
export const TRIGGER_CHROME = 16 + 2;

/**
 * What a trailing mark on a trigger adds once it has arrived, in px, the trigger's own `gap-1.5`
 * (6) included. A mark animates open after the fit is decided (`MARK_TRACK` in `ui/tabs.tsx`), so
 * the fit budgets for the widest a tab can get, not for what it shows now; otherwise a late badge
 * widens a trigger past its room and the strip clips again. `wideCount` is for a count with no
 * small ceiling (an event stream's length).
 */
export const MARK_ALLOWANCE = {
	none: 0,
	dot: 6 + 5,
	count: 6 + 2 * 6,
	wideCount: 6 + 5 * 6,
	chip: 6 + 40,
} as const;

/**
 * The width a section-tab trigger wants: its name at the bold weight (`TabLabel` reserves the
 * semibold width in every state), the trigger's padding, and room for the marks it may grow.
 * `measure` must be built at the trigger's 600 weight, not the strip's.
 */
export function naturalTriggerWidth(
	label: string,
	measure: (text: string) => number,
	markAllowance = 0
): number {
	return TRIGGER_CHROME + Math.ceil(measure(label)) + markAllowance;
}

export interface FitResult {
	/** Indices of the tabs to render, in strip order. */
	visible: number[];
	/** Indices that did not fit, in strip order. */
	overflowed: number[];
}

/** What the row spends on things that are not tabs. */
export interface FitOptions {
	/** Width the row spends on things that are not tabs (default: the New-tab button). */
	reserved?: number;
}

/**
 * Decide which tabs are shown, by two rules that are easy to get wrong:
 *
 * - The overflow control's width is reserved *before* choosing how many tabs to show: fitting one
 *   more tab and then finding nowhere for the "+3" hides tabs with no way to reach them.
 * - **The active tab is never overflowed.** A tab picked from the menu must come on screen, or the
 *   menu looks like it did nothing.
 */
export function fitTabs(
	widths: number[],
	availableWidth: number,
	activeIndex: number,
	{ reserved = TAB_NEW_BUTTON_WIDTH }: FitOptions = {}
): FitResult {
	const all = widths.map((_, i) => i);
	const room = availableWidth - reserved;
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
