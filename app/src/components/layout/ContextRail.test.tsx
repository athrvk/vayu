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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<ContextRail />
			</TooltipProvider>
		</QueryClientProvider>
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

	it("collapses the bar on the only real section, even alongside a hidden section with no toggle to collapse", async () => {
		// GraphQL's relevance hook (`useGraphQLRelevance`, `relevance.ts`) reads
		// `useRequestQuery`, which this test's bare `entityId` never backs with
		// real request data - so it resolves "hidden" deterministically, the same
		// as it would for any non-GraphQL request. A hidden section renders
		// `ContextBarSectionEmptyHeader` (`Section.tsx`), which has no toggle at
		// all, so it can never be added to `contextBarCollapsedSections`. That is
		// exactly the shape that broke `isOnlyExpanded` before this fix: GraphQL
		// counted as permanently "expanded" alongside Auth (never collapsed,
		// because never collapsible), `expandedIds.length` was 2 instead of 1, and
		// the bar never closed - "the right rail only expands, never collapses".
		const others = sectionsForTab({ id: "t1", type: "request", entityId: null })
			.map((s) => s.id)
			.filter((id) => id !== "auth" && id !== "graphql");
		useLayoutStore.setState({
			contextBarOpen: true,
			contextBarCollapsedSections: others,
		});
		renderRail();
		// The relevance probes settle via an effect - let them land before the
		// click needs their answer.
		await act(async () => {});
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
