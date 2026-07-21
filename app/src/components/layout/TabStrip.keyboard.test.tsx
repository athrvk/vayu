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

	it("leaves other keys alone so typing is not swallowed", () => {
		renderStrip();
		screen.getAllByRole("tab")[0].focus();

		press("ArrowUp");

		expect(useTabsStore.getState().openTabs).toHaveLength(3);
		expect(document.activeElement).toBe(screen.getAllByRole("tab")[0]);
	});
});
