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
 * Where `tab-focus` leaves focus when the tab it means is not in the DOM - the
 * strip draws only the tabs that fit, so the active or moved tab can be absent
 * and focus falls back to the strip's roving stop rather than being lost.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { focusActiveTab, moveTabAndFocus } from "./tab-focus";
import { tabElementId } from "./tab-aria";
import { useTabsStore } from "@/stores";

function addTab(options: { id?: string; tabIndex: number }): HTMLElement {
	const el = document.createElement("button");
	el.setAttribute("role", "tab");
	el.tabIndex = options.tabIndex;
	if (options.id) el.id = options.id;
	document.body.append(el);
	return el;
}

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [
			{ id: "t1", type: "request", entityId: "r1" },
			{ id: "t2", type: "request", entityId: "r2" },
		],
		activeTabId: "t1",
	});
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("focusActiveTab", () => {
	it("focuses the active tab's element", () => {
		addTab({ tabIndex: -1 }); // another tab, not the roving stop
		const active = addTab({ id: tabElementId("t1"), tabIndex: -1 });
		focusActiveTab();
		expect(active).toHaveFocus();
	});

	it("falls back to the roving stop when the strip has not drawn the active tab", () => {
		addTab({ tabIndex: -1 });
		const stop = addTab({ tabIndex: 0 });
		focusActiveTab();
		expect(stop).toHaveFocus();
	});

	it("does nothing when there is no strip at all", () => {
		expect(() => focusActiveTab()).not.toThrow();
		expect(document.body).toHaveFocus();
	});
});

describe("moveTabAndFocus", () => {
	it("focuses the moved tab's element", () => {
		const moved = addTab({ id: tabElementId("t1"), tabIndex: -1 });
		addTab({ tabIndex: 0 });
		moveTabAndFocus("t1", 1);
		expect(moved).toHaveFocus();
		expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual(["t2", "t1"]);
	});

	it("falls back to the roving stop when the moved tab is not drawn", () => {
		const stop = addTab({ tabIndex: 0 });
		moveTabAndFocus("t1", 1);
		expect(stop).toHaveFocus();
	});
});
