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
 * The Shell's sidebar effect: when navigating to a tab, the drawer
 * automatically switches to the matching view, or stays put if the tab type
 * has no drawer. This test guards against a bug where opening a run would
 * throw the user out of the History list.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore } from "@/stores";

vi.mock("./Drawer", () => ({
	Drawer: () => <div data-testid="drawer" />,
}));

vi.mock("./Dock", () => ({
	Dock: () => <div data-testid="dock" />,
}));

vi.mock("./ContextBar", () => ({
	ContextBar: () => <div data-testid="context-bar" />,
}));

vi.mock("@/modules/collections/ImportModal", () => ({
	ImportModal: () => <div data-testid="import-modal" />,
}));

vi.mock("@/modules/request-builder", () => ({
	default: () => <div data-testid="request-builder" />,
}));

vi.mock("@/modules/collections/CollectionDetail", () => ({
	default: () => <div data-testid="collection-detail" />,
}));

vi.mock("@/modules/dashboard", () => ({
	default: () => <div data-testid="dashboard" />,
}));

vi.mock("@/modules/history/main", () => ({
	HistoryDetail: () => <div data-testid="history-detail" />,
}));

vi.mock("@/modules/welcome/WelcomeScreen", () => ({
	default: () => <div data-testid="welcome-screen" />,
}));

vi.mock("@/modules/settings", () => ({
	SettingsMain: () => <div data-testid="settings-main" />,
}));

vi.mock("@/modules/variables/main/VariablesMain", () => ({
	default: () => <div data-testid="variables-main" />,
}));

function renderShell() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<Shell />
		</QueryClientProvider>
	);
}

describe("Shell sidebar auto-view effect", () => {
	beforeEach(() => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useLayoutStore.setState({
			drawerOpen: true,
			drawerView: "history",
			drawerWidth: 300,
			contextBarOpen: false,
			contextBarWidth: 400,
			requestSplitRatio: 0.5,
		});
	});

	it("switches to variables view when a variables tab becomes active", () => {
		const tabId = "var-tab";
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "variables", entityId: null }],
			activeTabId: tabId,
		});

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("variables");
	});

	it("switches to settings view when a settings tab becomes active", () => {
		const tabId = "settings-tab";
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "settings", entityId: null }],
			activeTabId: tabId,
		});

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("settings");
	});

	it("switches to collections view when a request tab becomes active", () => {
		const tabId = "request-tab";
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "request", entityId: "req-123" }],
			activeTabId: tabId,
		});

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("collections");
	});

	it("switches to collections view when a collection tab becomes active", () => {
		const tabId = "collection-tab";
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "collection", entityId: "col-123" }],
			activeTabId: tabId,
		});

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("collections");
	});

	it("leaves the drawer view unchanged when a run tab becomes active", () => {
		const tabId = "run-tab";
		useLayoutStore.setState({ drawerView: "history" });
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "run", entityId: "run-123" }],
			activeTabId: tabId,
		});

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("history");
	});

	it("leaves the drawer view unchanged when no tab is active", () => {
		useLayoutStore.setState({ drawerView: "history" });
		useTabsStore.setState({ openTabs: [], activeTabId: null });

		renderShell();

		const { drawerView } = useLayoutStore.getState();
		expect(drawerView).toBe("history");
	});

	/*
	 * Switching *into* a collection tab, not mounting on one. The bug reported
	 * here was that a collection tab loaded its detail pane but the sidebar did
	 * not follow, while settings and request tabs did - and this effect treats
	 * collection and request identically, which is what pointed the
	 * investigation at CollectionTree's reveal effect instead. The Shell half is
	 * pinned anyway, because it is the half that would silently regress if
	 * someone trimmed the `||` in that condition.
	 */
	it("switches to collections view when a collection tab becomes active", () => {
		const tabId = "collection-tab";
		useTabsStore.setState({
			openTabs: [{ id: tabId, type: "collection", entityId: "col-1" }],
			activeTabId: tabId,
		});

		renderShell();

		expect(useLayoutStore.getState().drawerView).toBe("collections");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});

	it("follows a switch from a settings tab to a collection tab", () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "s1", type: "settings", entityId: null },
				{ id: "c1", type: "collection", entityId: "col-1" },
			],
			activeTabId: "s1",
		});
		renderShell();
		expect(useLayoutStore.getState().drawerView).toBe("settings");

		// The real flow: the Shell is already mounted and the active tab changes.
		act(() => useTabsStore.setState({ activeTabId: "c1" }));
		expect(useLayoutStore.getState().drawerView).toBe("collections");
	});
});
