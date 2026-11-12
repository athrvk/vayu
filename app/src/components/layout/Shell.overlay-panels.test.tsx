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
 * The Shell's half of the overlay rules (#3507): it hands each side panel both
 * modes, and a selection that changes the active tab's type must not be undone
 * by the Shell's own reveal-the-drawer effect. The rules themselves are
 * `useOverlayPanel.test.tsx`; this renders the real Shell, drawer and bar.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { TooltipProvider } from "@/components/ui";
import { useDrawerItemOpened } from "./drawer-item-opened";
import { useTabsStore, useLayoutStore } from "@/stores";
import { CONTEXT_BAR_PUSH_MIN_WIDTH, DRAWER_PUSH_MIN_WIDTH } from "@/constants/layout";

vi.mock("@/modules/collections/CollectionTree", async () => {
	const { useTabsStore: tabs } = await import("@/stores");
	return {
		default: function TreeStub() {
			const onItemOpened = useDrawerItemOpened();
			return (
				<button
					onClick={() => {
						tabs.getState().openTab({ type: "collection", entityId: "c1" });
						onItemOpened();
					}}
				>
					open collection
				</button>
			);
		},
	};
});
vi.mock("@/modules/history/sidebar/HistoryList", () => ({ default: () => null }));
vi.mock("@/modules/variables/sidebar/VariablesCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/settings/sidebar/SettingsCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/services", () => ({ ServicesPanel: () => null }));
vi.mock("@/modules/trash", () => ({ TrashList: () => null }));
vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request"
			? [
					{
						id: "alpha",
						title: "Alpha",
						appliesTo: () => true,
						Component: () => <p>alpha</p>,
					},
				]
			: [],
}));
vi.mock("./Dock", () => ({ Dock: () => null }));
vi.mock("./ActivityRail", () => ({ ActivityRail: () => null }));
vi.mock("./ContextRail", () => ({ ContextRail: () => null }));
vi.mock("@/modules/collections/ImportModal", () => ({ ImportModal: () => null }));
vi.mock("@/modules/collections/CollectionDetail", () => ({ default: () => null }));
vi.mock("@/modules/dashboard", () => ({ default: () => null }));
vi.mock("@/modules/history/main/HistoryDetail", () => ({ default: () => null }));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({ default: () => null }));
vi.mock("@/modules/settings/main/SettingsMain", () => ({ default: () => null }));
vi.mock("@/modules/variables/main/VariablesMain", () => ({ default: () => null }));
vi.mock("@/modules/request-builder", () => ({ default: () => null }));

function renderShellAt(width: number) {
	vi.stubGlobal("innerWidth", width);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<Shell />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const layout = () => useLayoutStore.getState();

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
		activeTabId: "t1",
	});
	useLayoutStore.setState({
		drawerOpen: true,
		drawerView: "collections",
		drawerWidth: 260,
		contextBarOpen: false,
		contextBarCollapsedSections: [],
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Shell - selecting from the drawer", () => {
	it("leaves the overlay closed after a pick that changes the tab's type", () => {
		// request -> collection: the Shell's effect reveals the drawer for that
		// type, which is the reopening the seam has to get ahead of.
		renderShellAt(DRAWER_PUSH_MIN_WIDTH - 1);
		fireEvent.click(screen.getByRole("button", { name: "open collection" }));
		expect(useTabsStore.getState().activeTabId).not.toBe("t1");
		expect(layout().drawerOpen).toBe(false);
	});

	it("keeps a pushing drawer open", () => {
		renderShellAt(DRAWER_PUSH_MIN_WIDTH);
		fireEvent.click(screen.getByRole("button", { name: "open collection" }));
		expect(layout().drawerOpen).toBe(true);
	});
});

describe("Shell - one overlay at a time", () => {
	// Request tab, bar opened (the drawer yields), then Settings: the bar has
	// nothing to show there and the reveal reopens the drawer. Closing Settings
	// brings the bar back and reveals the drawer in the same commit.
	it("never leaves both open when a tab switch brings the bar back under a revealed drawer", () => {
		layout().setDrawerOpen(false);
		renderShellAt(DRAWER_PUSH_MIN_WIDTH - 1);
		act(() => layout().setContextBarOpen(true));
		expect(layout().drawerOpen).toBe(false);

		act(() => useTabsStore.getState().openTab({ type: "settings", entityId: null }));
		expect(layout().drawerOpen).toBe(true);
		// Hidden, not closed: the user's flag is not rewritten for a panel that is off screen.
		expect(layout().contextBarOpen).toBe(true);

		const settingsId = useTabsStore.getState().activeTabId!;
		act(() => useTabsStore.getState().closeTab(settingsId));
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect([layout().drawerOpen, layout().contextBarOpen].filter(Boolean)).toHaveLength(1);
	});

	it("keeps the drawer, and writes the bar's flag false, when a resize makes both overlays", () => {
		layout().setContextBarOpen(true);
		renderShellAt(CONTEXT_BAR_PUSH_MIN_WIDTH);
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(true);

		vi.stubGlobal("innerWidth", DRAWER_PUSH_MIN_WIDTH - 1);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);
	});

	it("closes the drawer when the bar opens below both thresholds", () => {
		renderShellAt(DRAWER_PUSH_MIN_WIDTH - 1);
		act(() => layout().setContextBarOpen(true));
		expect(layout().contextBarOpen).toBe(true);
		expect(layout().drawerOpen).toBe(false);
	});

	it("keeps both between the thresholds, where only the bar overlays", () => {
		renderShellAt(CONTEXT_BAR_PUSH_MIN_WIDTH - 1);
		act(() => layout().setContextBarOpen(true));
		expect(layout().contextBarOpen).toBe(true);
		expect(layout().drawerOpen).toBe(true);
	});

	it("keeps both at the context bar's threshold, where both push", () => {
		renderShellAt(CONTEXT_BAR_PUSH_MIN_WIDTH);
		act(() => layout().setContextBarOpen(true));
		expect(layout().contextBarOpen).toBe(true);
		expect(layout().drawerOpen).toBe(true);
	});
});
