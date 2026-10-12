/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reordering the strip - `moveTab`.
 *
 * Two things are pinned beyond the new order. A move reorders `openTabs` and
 * touches nothing else: the active tab, the focus stamps and the navigation
 * history name tabs by id and location, so a move that rewrote any of them
 * would be a navigation the user never made. And the `Tab` objects are reused,
 * because `TabItem`'s memo compares them by identity - a copy would re-render
 * every tab on every move.
 *
 * jsdom for the persistence case: the order has to survive a reload, and the
 * store writes `localStorage` as it changes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useTabsStore } from "./tabs-store";

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [],
		activeTabId: null,
		tabFocusedAt: {},
		navHistory: [],
		navIndex: -1,
	});
	localStorage.clear();
});

const store = () => useTabsStore.getState();

/** Open request tabs a, b, c, d in that order; the last is left active. */
function openAbcd() {
	for (const id of ["a", "b", "c", "d"]) store().openTab({ type: "request", entityId: id });
}

/** The id of the tab showing `entityId`. */
function tabId(entityId: string): string {
	const tab = store().openTabs.find((t) => t.entityId === entityId);
	if (!tab) throw new Error(`No open tab for ${entityId}`);
	return tab.id;
}

const order = () => store().openTabs.map((t) => t.entityId);

describe("moveTab", () => {
	it("moves a tab to a later place, the index it occupies afterwards", () => {
		openAbcd();
		store().moveTab(tabId("a"), 2);
		expect(order()).toEqual(["b", "c", "a", "d"]);
	});

	it("moves a tab to an earlier place", () => {
		openAbcd();
		store().moveTab(tabId("d"), 0);
		expect(order()).toEqual(["d", "a", "b", "c"]);
	});

	it("clamps an index past the end to the last place", () => {
		openAbcd();
		store().moveTab(tabId("a"), 99);
		expect(order()).toEqual(["b", "c", "d", "a"]);
	});

	// Not `d, -5`: `splice` reads a negative start from the end, so an unclamped
	// index lands here by accident for some tabs and not others.
	it("clamps a negative index to the first place", () => {
		openAbcd();
		store().moveTab(tabId("c"), -1);
		expect(order()).toEqual(["c", "a", "b", "d"]);

		store().moveTab(tabId("a"), -5);
		expect(order()).toEqual(["a", "c", "b", "d"]);
	});

	it("truncates a fractional index", () => {
		openAbcd();
		store().moveTab(tabId("a"), 1.9);
		expect(order()).toEqual(["b", "a", "c", "d"]);
	});

	it("leaves openTabs untouched, not merely equal, when there is nothing to do", () => {
		openAbcd();
		const before = store().openTabs;

		store().moveTab(tabId("b"), 1);
		expect(store().openTabs).toBe(before);

		store().moveTab("missing", 1);
		expect(store().openTabs).toBe(before);

		// An index past an end clamps onto the tab's own place: still nothing to do.
		store().moveTab(tabId("d"), 99);
		store().moveTab(tabId("a"), -5);
		expect(store().openTabs).toBe(before);
	});

	it("changes nothing but the order", () => {
		openAbcd();
		store().focusTab(tabId("b"));
		const { activeTabId, tabFocusedAt, navHistory, navIndex, openTabs } = store();
		const before = {
			activeTabId,
			tabFocusedAt: { ...tabFocusedAt },
			navHistory: [...navHistory],
			navIndex,
		};

		store().moveTab(tabId("a"), 3);

		expect(order()).toEqual(["b", "c", "d", "a"]);
		expect(store().activeTabId).toEqual(before.activeTabId);
		expect(store().tabFocusedAt).toEqual(before.tabFocusedAt);
		expect(store().navHistory).toEqual(before.navHistory);
		expect(store().navIndex).toEqual(before.navIndex);
		// The same objects, moved: `tabItemPropsEqual` reads `prev.tab === next.tab`.
		for (const tab of openTabs) {
			expect(store().openTabs.find((t) => t.id === tab.id)).toBe(tab);
		}
	});

	it("persists the new order", () => {
		openAbcd();
		store().moveTab(tabId("a"), 2);

		const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.TABS_STORE) ?? "null");
		expect(saved.state.openTabs.map((t: { entityId: string }) => t.entityId)).toEqual([
			"b",
			"c",
			"a",
			"d",
		]);
	});
});
