/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Moving focus *between* the shell's regions, rather than within one (#1219).
 *
 * The window is four bands - the title bar, the drawer, the main pane and the
 * context bar - and until now the only way from one to another was Tab, which
 * walks every request in an expanded collection tree on the way. F6 cycles
 * them; ⌘L jumps to the one field people ask for by name.
 *
 * **Marked, not queried by tag.** A `querySelectorAll("header, aside, main")`
 * looks like it would do, and it picks up the run view's `<header>`, the
 * breadcrumb's `<nav>` and the inbox's own `<aside>` - content landmarks
 * *inside* `main`, so the cycle would walk around inside one region forever.
 * The four bands carry `data-app-region` instead: the shell says which of its
 * children are regions, and a feature adding a landmark of its own cannot join
 * the cycle by accident.
 *
 * A region that is not on screen simply is not in the DOM - the drawer returns
 * `null` when closed, the context bar when closed or when the active tab has
 * nothing to show, the title bar outside Electron - so the cycle needs no
 * knowledge of any of that, and a region holding nothing focusable is stepped
 * over rather than swallowing the press.
 *
 * Focus lands on the region's first focusable element rather than on the region
 * box itself. A `tabindex="-1"` container would announce its landmark name,
 * which is the textbook F6, and the app's `:focus-visible` rule deliberately
 * does not paint `[tabindex="-1"]` - so it would move focus with nothing on
 * screen saying where it went, which for a keyboard-only feature is worse than
 * the name is worth.
 */

import { REQUEST_URL_INPUT_ID } from "@/constants/dom-ids";
import { focusableWithin, focusFirstOf } from "@/lib/focusable";

/** Marks one of the shell's bands as a stop in the F6 cycle. */
export const REGION_ATTRIBUTE = "data-app-region";

/**
 * The regions, named. The value is what the attribute carries; the cycle order
 * is document order, not this list, so a band moving in the layout moves in the
 * cycle without an edit here.
 */
export type AppRegion = "banner" | "drawer" | "main" | "context";

/** Every region currently on screen, in document order. */
export function appRegions(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>(`[${REGION_ATTRIBUTE}]`));
}

/** Index arithmetic that wraps at both ends, including for a negative step. */
function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Move focus to the next region (`step` of 1) or the previous one (-1),
 * wrapping around, and skipping any region with nothing focusable in it.
 *
 * Returns whether focus moved. The caller has nowhere better to send it when
 * this is `false`, so nothing acts on it - the reader is the test, which is
 * what makes "one region, nowhere to go" a case rather than an assumption.
 */
export function cycleRegionFocus(step: 1 | -1): boolean {
	const regions = appRegions();
	if (regions.length === 0) return false;

	const active = document.activeElement;
	const from = active instanceof HTMLElement ? regions.findIndex((r) => r.contains(active)) : -1;

	// From outside every region, forwards starts at the first band and
	// backwards at the last - the same wrap the cycle uses everywhere else.
	const start = from === -1 ? (step === 1 ? 0 : regions.length - 1) : from + step;
	// The region focus is already in is never a destination: landing back on
	// its first control would read as the key having jumped somewhere random.
	const stops = from === -1 ? regions.length : regions.length - 1;

	for (let i = 0; i < stops; i++) {
		const region = regions[wrap(start + i * step, regions.length)];
		if (focusFirstOf(focusableWithin(region))) return true;
	}
	return false;
}

/**
 * Put the caret in the request URL field, with its contents selected - the
 * browser behaviour ⌘L borrows from, where the point is to type a new address
 * over the old one.
 *
 * Reached by id rather than by a ref, because the caller is the Shell and the
 * field is inside the request builder, mounted only while a request tab is
 * open. No field on screen means no focus to move, which is the honest outcome
 * of asking for the URL bar on the settings tab.
 */
export function focusRequestUrl(): boolean {
	const input = document.getElementById(REQUEST_URL_INPUT_ID);
	if (!(input instanceof HTMLInputElement)) return false;
	input.focus();
	if (document.activeElement !== input) return false;
	input.select();
	return true;
}
