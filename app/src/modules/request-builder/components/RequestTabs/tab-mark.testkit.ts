/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a request tab's trailing mark looks like in the DOM, for the tests that
 * say Info, Body, Auth and Settings badge *presence* (a dot, #2199) and never a
 * number.
 *
 * jsdom lays nothing out, so "visible" is the track's class
 * (`grid-cols-[1fr]` open, `grid-cols-[0fr]` collapsed) and the dot's presence
 * in the slot; the accessible name is what proves the mark added no text.
 */

import { expect } from "vitest";

const slotOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>("[data-slot='tab-count']");

/** The tab shows the presence dot, in an open track, with no text in the slot. */
export function expectPresenceDot(tab: HTMLElement, name: string) {
	const slot = slotOf(tab);
	expect(slot, "the tab has no mark slot").not.toBeNull();
	expect(slot?.className).toContain("grid-cols-[1fr]");
	const dot = slot?.querySelector("[data-slot='tab-presence-dot']");
	expect(dot, "the open track holds no dot").not.toBeNull();
	// Never a digit: the whole point of the dot is that it counts nothing.
	expect(slot?.textContent).toBe("");
	expect(dot?.getAttribute("aria-hidden")).toBe("true");
	expect(tab).toHaveAccessibleName(name);
}

/** The tab is quiet: a collapsed track, no dot, no text, the bare label as name. */
export function expectNoMark(tab: HTMLElement, name: string) {
	const slot = slotOf(tab);
	expect(slot, "the slot must stay mounted so a mark can grow in").not.toBeNull();
	expect(slot?.className).toContain("grid-cols-[0fr]");
	expect(slot?.querySelector("[data-slot='tab-presence-dot']")).toBeNull();
	expect(slot?.textContent).toBe("");
	expect(tab).toHaveAccessibleName(name);
}
