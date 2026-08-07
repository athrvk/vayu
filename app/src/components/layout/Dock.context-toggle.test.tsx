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
 * The context-bar toggle reports what is on screen, not what is stored.
 *
 * The Dock button and Ctrl/Cmd+I flip `contextBarOpen` on every tab type, while
 * the bar renders null off a request tab - so on six of the seven types the
 * button lit up and nothing appeared, and because the flag is persisted the bar
 * then popped out later on the next request tab.
 *
 * Mutation-check: drive `active` from `contextBarOpen` alone again and the
 * non-request cases redden.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dock } from "./Dock";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore, type TabType } from "@/stores";

// Injected by vite's `define` in the real build; the Dock renders it.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

function renderDock() {
	return render(
		<TooltipProvider>
			<Dock />
		</TooltipProvider>
	);
}

function openTabOfType(type: TabType) {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type, entityId: type === "request" ? "req_1" : null }],
		activeTabId: "t1",
	});
}

function toggle(): HTMLElement {
	return screen.getByRole("button", { name: "Toggle context bar" });
}

beforeEach(() => {
	useLayoutStore.setState({ contextBarOpen: true });
});

describe("Dock - the context-bar toggle's pressed state", () => {
	it("is pressed on a request tab with the bar open", () => {
		openTabOfType("request");
		renderDock();
		expect(toggle()).toHaveAttribute("aria-pressed", "true");
	});

	it("is not pressed on a request tab with the bar closed", () => {
		useLayoutStore.setState({ contextBarOpen: false });
		openTabOfType("request");
		renderDock();
		expect(toggle()).toHaveAttribute("aria-pressed", "false");
	});

	it.each<TabType>(["welcome", "collection", "dashboard", "run", "variables", "settings"])(
		"is not pressed on a %s tab even with the flag set",
		(type) => {
			openTabOfType(type);
			renderDock();
			expect(toggle()).toHaveAttribute("aria-pressed", "false");
		}
	);

	it("is not pressed when no tab is active", () => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		renderDock();
		expect(toggle()).toHaveAttribute("aria-pressed", "false");
	});
});
