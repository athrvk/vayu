/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Moving focus *between* the shell's regions, not within one (#1219).
 *
 * The window is eight bands: the title bar, the activity rail, the drawer, the main pane, the
 * context bar, the context rail, the bottom panel and the Dock. Without this, Tab is the only way
 * between them, and it walks every request in an expanded collection tree. F6 cycles them; ⌘L jumps
 * to the one field people ask for by name. The activity rail is a band so a keyboard user reaches
 * primary navigation with the drawer collapsed (#1615); the context rail and the Dock joined in
 * #3498, the Dock being the one band whose controls no other key reaches without walking the whole
 * window; the bottom panel in #3635.
 *
 * **The tab strip is deliberately not a band.** It is the main pane's header, directly above `main`
 * in document order and one tab stop (a roving tablist), so Shift+Tab from the pane's first control
 * reaches it, and its chords (⇧⌘[ / ⇧⌘], ⌘1-9) switch tabs from anywhere. A stop of its own would
 * put a second press between every band and the pane people F6 to most.
 *
 * **Marked, not queried by tag.** `querySelectorAll("header, aside, main")` would pick up the run
 * view's `<header>`, the breadcrumb's `<nav>` and the inbox's `<aside>`, content landmarks *inside*
 * `main`, and the cycle would circle inside one region forever. The bands carry `data-app-region`:
 * the shell says which children are regions, and a feature's own landmark cannot join by accident.
 *
 * A region not on screen is not in the DOM (the drawer and context bar when closed, the context bar
 * when the tab has nothing to show, the title bar outside Electron), so the cycle needs no
 * knowledge of that, and a region with nothing focusable is stepped over rather than swallowing the
 * press.
 *
 * Focus lands on the region's first focusable element, not the region box. A `tabindex="-1"`
 * container would announce its landmark name, the textbook F6, but the app's `:focus-visible` rule
 * deliberately does not paint `[tabindex="-1"]`, so focus would move with nothing on screen saying
 * where, which for a keyboard-only feature costs more than the name is worth.
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
export type AppRegion =
	"banner" | "rail" | "drawer" | "main" | "context" | "context-rail" | "bottom-panel" | "dock";

/**
 * The props that mark a band, spread onto it: `<aside {...regionProps("drawer")}>`.
 *
 * Spread, not written as an attribute, for two reasons. A JSX attribute *name* has to be a literal,
 * so hand-spelled `data-app-region`s leave `REGION_ATTRIBUTE` read only by the query, and a rename
 * leaves them behind. And a value typed inline (`{"drawer" satisfies AppRegion}`) is a case
 * `jsx-ast-utils` lacks: on each `<aside>` band, the one tag `jsx-a11y/role-supports-aria-props`
 * resolves an implicit role for, every `pnpm lint` run would print a `TSSatisfiesExpression`
 * advisory asking for an upstream bug (#1261).
 *
 * The parameter also types the name tighter than `satisfies`: a name outside the union is an error
 * at the call, not on the value.
 */
export function regionProps(region: AppRegion): Record<typeof REGION_ATTRIBUTE, AppRegion> {
	return { [REGION_ATTRIBUTE]: region };
}

/** Every region currently on screen, in document order. */
export function appRegions(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>(`[${REGION_ATTRIBUTE}]`));
}

/** Index arithmetic that wraps at both ends, including for a negative step. */
function wrap(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Move focus to the next region (`step` 1) or the previous (-1), wrapping, and skipping any region
 * with nothing focusable.
 *
 * Returns whether focus moved. No caller acts on `false`, having nowhere better to send focus; the
 * reader is the test, which makes "one region, nowhere to go" a case rather than an assumption.
 */
export function cycleRegionFocus(step: 1 | -1): boolean {
	const regions = appRegions();
	if (regions.length === 0) return false;

	const active = document.activeElement;
	const from = active instanceof HTMLElement ? regions.findIndex((r) => r.contains(active)) : -1;

	// From outside every region, forwards starts at the first band and backwards at the last, the
	// cycle's usual wrap.
	const start = from === -1 ? (step === 1 ? 0 : regions.length - 1) : from + step;
	// The region focus is in is never a destination: landing on its first control again would read
	// as a jump somewhere random.
	const stops = from === -1 ? regions.length : regions.length - 1;

	for (let i = 0; i < stops; i++) {
		const region = regions[wrap(start + i * step, regions.length)];
		if (focusFirstOf(focusableWithin(region))) return true;
	}
	return false;
}

/**
 * Put the caret in the request URL field with its contents selected, the browser behaviour ⌘L
 * borrows, where the point is to type a new address over the old.
 *
 * Reached by id, not a ref: the caller is the Shell, and the field is in the request builder,
 * mounted only while a request tab is open. No field means no focus to move, the honest outcome of
 * asking for the URL bar on the settings tab.
 */
export function focusRequestUrl(): boolean {
	const input = document.getElementById(REQUEST_URL_INPUT_ID);
	if (!(input instanceof HTMLInputElement)) return false;
	input.focus();
	if (document.activeElement !== input) return false;
	input.select();
	return true;
}
