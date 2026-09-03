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
 * The tab strip has to be usable without a mouse.
 *
 * This is a desktop tool for developers, who live on the keyboard, and the strip
 * had three problems:
 *
 *   - Every tab carried `tabIndex={0}`, so a dozen open tabs meant a dozen Tab
 *     presses to get past the strip. The strip should be one stop.
 *   - `role="tablist"` promises arrow-key navigation. Nothing handled arrows.
 *   - Closing a tab was mouse-only. The X is `tabIndex={-1}` and only appears on
 *     hover, and there is no close shortcut anywhere in the app.
 *
 * Tabs are chosen so no request query is involved; the strip renders those from
 * TanStack Query and this is a keyboard test, not a data test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { tabElementId, tabPanelElementId } from "./tab-aria";
import { useTabsStore } from "@/stores";

/**
 * Keys go to whatever currently has focus, which is what a real key press does
 * and what the roving-tabindex behaviour is about. `user-event` is not a
 * dependency of this project and one keyboard test does not justify adding it.
 */
function press(key: string) {
	fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

function renderStrip() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TabStrip />
		</QueryClientProvider>
	);
}

const TABS = [
	{ id: "t1", type: "welcome" as const, entityId: null },
	{ id: "t2", type: "settings" as const, entityId: null },
	{ id: "t3", type: "variables" as const, entityId: null },
];

beforeEach(() => {
	useTabsStore.setState({ openTabs: [...TABS], activeTabId: "t1" });
});

describe("TabStrip keyboard navigation", () => {
	it("is a single Tab stop, not one per open tab", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);
		// Roving tabindex: exactly one reachable entry point.
		expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
		expect(tabs[0]).toHaveAttribute("tabindex", "0");
	});

	/*
	 * The single-stop claim held only on the first render. Arrow navigation moved
	 * focus by writing `tabIndex = 0` straight onto the destination element and
	 * left it there: the vdom prop for that tab is still -1, so React re-renders
	 * to nothing, and focus moves *without* activating, so there is no render to
	 * rely on in the first place. Three arrow presses, three permanent Tab stops -
	 * the defect roving tabindex exists to prevent, reintroduced by its own
	 * navigation. The test above cannot see it, because it never presses a key.
	 */
	it("still has exactly one Tab stop after arrowing across the strip", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("ArrowRight");
		press("ArrowRight");
		press("ArrowLeft");

		const stops = tabs.filter((t) => t.getAttribute("tabindex") === "0");
		expect(stops).toHaveLength(1);
		// And it is where focus actually is, so Tab back into the strip returns here.
		expect(stops[0]).toBe(tabs[1]);
		expect(document.activeElement).toBe(tabs[1]);
	});

	it("leaves one Tab stop after Home and End too", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("End");
		press("Home");

		expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
	});

	it("moves focus with Left and Right arrows", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("ArrowRight");
		expect(document.activeElement).toBe(tabs[1]);

		press("ArrowRight");
		expect(document.activeElement).toBe(tabs[2]);

		press("ArrowLeft");
		expect(document.activeElement).toBe(tabs[1]);
	});

	it("wraps at both ends", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("ArrowLeft");
		expect(document.activeElement).toBe(tabs[2]);

		press("ArrowRight");
		expect(document.activeElement).toBe(tabs[0]);
	});

	it("jumps to the ends with Home and End", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[1].focus();
		press("End");
		expect(document.activeElement).toBe(tabs[2]);

		press("Home");
		expect(document.activeElement).toBe(tabs[0]);
	});

	it("moves focus without activating, so skating past a heavy tab mounts nothing", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("ArrowRight");

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	it("activates the focused tab with Enter", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");

		tabs[0].focus();
		press("ArrowRight");
		press("Enter");
		expect(useTabsStore.getState().activeTabId).toBe("t2");
	});

	it("closes the focused tab with Delete", () => {
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("Delete");

		const ids = useTabsStore.getState().openTabs.map((t) => t.id);
		expect(ids).toEqual(["t2", "t3"]);
	});

	/*
	 * The macOS half of that key (#931). A Mac keyboard's "delete" reports
	 * "Backspace" - "Delete" is forward-delete, Fn+Delete - so the case above
	 * passed everywhere while closing nothing on a Mac.
	 *
	 * Asserted as a key, not as a platform: the handler has no `isMac` branch, so
	 * both keys close a tab in the same run wherever it runs.
	 */
	it("closes the focused tab with Backspace too, since Mac delete is Backspace", () => {
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("Backspace");

		expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual(["t2", "t3"]);
	});

	/*
	 * The tab holding focus is the one that unmounts, so a close that claims no
	 * focus drops the user on `<body>` and the next Tab restarts from the top of
	 * the document (#1218). Where it lands is the store's own next active tab -
	 * one rule for what follows a close, not a second one here.
	 */
	it("leaves focus on the tab that replaces the closed one", () => {
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("Delete");

		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(document.activeElement).toBe(document.getElementById(tabElementId("t2")));
	});

	it("leaves focus on the active tab when the closed one was not active", () => {
		renderStrip();
		// t1 is active; closing t2 does not change that, so focus follows the
		// tab that is still selected rather than a neighbour nothing points at.
		screen.getAllByRole("tab")[1].focus();

		press("Backspace");

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(document.activeElement).toBe(document.getElementById(tabElementId("t1")));
	});

	it("falls back to the New tab button when the last tab closes", () => {
		useTabsStore.setState({ openTabs: [TABS[0]], activeTabId: "t1" });
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("Delete");

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
		expect(document.activeElement).toBe(screen.getByLabelText("New tab"));
	});

	it("leaves other keys alone so typing is not swallowed", () => {
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("ArrowUp");

		expect(useTabsStore.getState().openTabs).toHaveLength(3);
		expect(document.activeElement).toBe(screen.getAllByRole("tab")[0]);
	});
});

/**
 * The strip declared `role="tablist"` and `aria-selected` and stopped there: no
 * tab named the region it switches, and the region named no tab. A screen reader
 * reached "tab 2 of 3" and then content with no stated relationship to it.
 *
 * The panel half lives in Shell, so it is asserted where the two meet
 * (`shell-tab-identity.test.tsx`); here is the strip's end of the contract, plus
 * the structural rule that a tablist owns only tabs.
 */
describe("TabStrip tabs pattern", () => {
	it("points every tab at the panel id its content will carry", () => {
		renderStrip();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);

		for (const [i, tab] of tabs.entries()) {
			expect(tab).toHaveAttribute("id", tabElementId(TABS[i].id));
			expect(tab).toHaveAttribute("aria-controls", tabPanelElementId(TABS[i].id));
		}
		// Distinct ids, or `aria-labelledby` on the panel resolves to whichever
		// element the document happens to reach first.
		expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
	});

	it("keeps the New-tab button out of the tab set", () => {
		renderStrip();
		const list = screen.getByRole("tablist");
		// Inside the tablist it is announced as one of the tabs - "4 of 4", with a
		// fourth that opens nothing. Same for the overflow trigger, which the
		// narrow-strip case in TabStrip.overflow.test.tsx covers.
		expect(list.contains(screen.getByLabelText("New tab"))).toBe(false);
		for (const tab of screen.getAllByRole("tab")) expect(list.contains(tab)).toBe(true);
	});
});
