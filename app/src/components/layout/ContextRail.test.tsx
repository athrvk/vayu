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
 * The right-edge counterpart to `ActivityRail` (#1615), replacing the Dock's
 * single "Toggle context bar" button (`Dock.context-toggle.test.tsx`'s former
 * claim - the pressed state read `contextBarOpen && contextBarHasContent`,
 * which each of this rail's per-section buttons now does individually).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore, type TabType } from "@/stores";
import { sectionsForTab } from "./context-bar/registry";
import { ContextRail } from "./ContextRail";

const ENTITY_TYPES: TabType[] = ["request", "collection", "run"];

function openTabOfType(type: TabType, entityId = ENTITY_TYPES.includes(type) ? `${type}_1` : null) {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type, entityId }],
		activeTabId: "t1",
	});
}

function renderRail() {
	return render(
		<TooltipProvider>
			<ContextRail />
		</TooltipProvider>
	);
}

beforeEach(() => {
	useLayoutStore.setState({ contextBarOpen: false, contextBarCollapsedSections: [] });
});

describe("ContextRail - visibility", () => {
	it("renders one icon per section sectionsForTab returns, for a request tab", () => {
		openTabOfType("request");
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Context sections" });
		const titles = sectionsForTab({ id: "t1", type: "request", entityId: null }).map(
			(s) => s.title
		);
		expect(
			Array.from(nav.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))
		).toEqual(titles);
	});

	it("renders the collection sections for a collection tab", () => {
		openTabOfType("collection");
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Context sections" });
		expect(nav.querySelectorAll("button")).toHaveLength(
			sectionsForTab({ id: "t1", type: "collection", entityId: "collection_1" }).length
		);
	});

	it("renders the run sections for a run tab", () => {
		openTabOfType("run");
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Context sections" });
		expect(nav.querySelectorAll("button")).toHaveLength(
			sectionsForTab({ id: "t1", type: "run", entityId: "run_1" }).length
		);
	});

	it("renders nothing for a tab the bar has nothing for, like settings", () => {
		openTabOfType("settings");
		renderRail();
		expect(
			screen.queryByRole("navigation", { name: "Context sections" })
		).not.toBeInTheDocument();
	});

	it("renders nothing when no tab is active", () => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		renderRail();
		expect(
			screen.queryByRole("navigation", { name: "Context sections" })
		).not.toBeInTheDocument();
	});
});

describe("ContextRail - clicking a section", () => {
	beforeEach(() => openTabOfType("request"));

	it("opens the bar and expands a collapsed section", () => {
		useLayoutStore.setState({
			contextBarOpen: false,
			contextBarCollapsedSections: ["auth"],
		});
		renderRail();
		screen.getByRole("button", { name: "Auth" }).click();

		const state = useLayoutStore.getState();
		expect(state.contextBarOpen).toBe(true);
		expect(state.contextBarCollapsedSections).not.toContain("auth");
	});

	it("marks a section's button pressed only while the bar is open on it", () => {
		useLayoutStore.setState({ contextBarOpen: true, contextBarCollapsedSections: [] });
		renderRail();
		expect(screen.getByRole("button", { name: "Auth" })).toHaveAttribute(
			"aria-pressed",
			"true"
		);

		act(() => useLayoutStore.setState({ contextBarOpen: false }));
		expect(screen.getByRole("button", { name: "Auth" })).toHaveAttribute(
			"aria-pressed",
			"false"
		);
	});

	it("collapses the whole bar when clicking the icon of the only section expanded", () => {
		const others = sectionsForTab({ id: "t1", type: "request", entityId: null })
			.map((s) => s.id)
			.filter((id) => id !== "auth");
		useLayoutStore.setState({
			contextBarOpen: true,
			// Every section but "auth" is collapsed, so "auth" is the only one open.
			contextBarCollapsedSections: others,
		});
		renderRail();
		screen.getByRole("button", { name: "Auth" }).click();

		expect(useLayoutStore.getState().contextBarOpen).toBe(false);
	});

	it("does not collapse the bar when other sections are also expanded", () => {
		useLayoutStore.setState({ contextBarOpen: true, contextBarCollapsedSections: [] });
		renderRail();
		screen.getByRole("button", { name: "Auth" }).click();

		expect(useLayoutStore.getState().contextBarOpen).toBe(true);
	});
});
