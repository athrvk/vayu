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
 * Alt+Arrow on a focused tab moves the tab and does not also navigate (#2038).
 *
 * Off macOS the strip's Move tab left / right chord and Shell's Go back / Go
 * forward chord are the same key. The strip settles it by stopping the event
 * before it reaches `window`; `Shell.navigation.test.tsx` stands a plain div in
 * for that, which proves the listener respects a stop and says nothing about
 * whether the strip issues one. This file mounts the real `TabStrip` in the
 * real `Shell`, so removing the stop in the strip is what turns it red.
 *
 * `isMac` is read once at import, so each case loads a fresh module graph under
 * a stubbed platform (as `shortcuts.platform.test.ts` does) and drives the
 * stores of that same graph. Both platforms are asserted: off macOS the key is
 * contested, on macOS Go back is ⌘[ and nothing is.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Every surface Shell can mount, stubbed - the strip is the one real thing
// here. Same list as Shell.close-tab-focus.test.tsx.
vi.mock("./Drawer", () => ({ Drawer: () => <div data-testid="drawer" /> }));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ActivityRail", () => ({ ActivityRail: () => <div data-testid="activity-rail" /> }));
vi.mock("./ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar" /> }));
vi.mock("./ContextRail", () => ({ ContextRail: () => <div data-testid="context-rail" /> }));
vi.mock("@/modules/palette", () => ({ CommandPalette: () => <div data-testid="palette" /> }));
vi.mock("@/modules/collections/ImportModal", () => ({
	ImportModal: () => <div data-testid="import-modal" />,
}));
vi.mock("@/modules/request-builder", () => ({
	default: () => <div data-testid="request-builder" />,
}));
vi.mock("@/modules/collections/CollectionDetail", () => ({
	default: () => <div data-testid="collection-detail" />,
}));
vi.mock("@/modules/dashboard", () => ({ default: () => <div data-testid="dashboard" /> }));
vi.mock("@/modules/history/main/HistoryDetail", () => ({
	default: () => <div data-testid="history-detail" />,
}));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({
	default: () => <div data-testid="welcome-screen" />,
}));
vi.mock("@/modules/settings/main/SettingsMain", () => ({
	default: () => <div data-testid="settings-main" />,
}));
vi.mock("@/modules/variables/main/VariablesMain", () => ({
	default: () => <div data-testid="variables-main" />,
}));
vi.mock("@/modules/inbox", () => ({ default: () => <div data-testid="inbox" /> }));

type Platform = "darwin" | "linux";

/** Shell with the real strip, three tabs, and a history Go back would walk. */
async function mountOn(platform: Platform) {
	vi.resetModules();
	vi.stubGlobal("electronAPI", { platform });
	const [{ default: Shell }, { useTabsStore }, { tabElementId }] = await Promise.all([
		import("./Shell"),
		import("@/stores"),
		import("./tab-aria"),
	]);
	// Tab types that need no request query: this is a keyboard test.
	useTabsStore.setState({
		openTabs: [
			{ id: "t1", type: "welcome", entityId: null },
			{ id: "t2", type: "settings", entityId: null },
			{ id: "t3", type: "variables", entityId: null },
		],
		activeTabId: "t3",
		tabFocusedAt: {},
		navHistory: [
			{ type: "welcome", entityId: null },
			{ type: "settings", entityId: null },
			{ type: "variables", entityId: null },
		],
		navIndex: 2,
	});
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<Shell />
		</QueryClientProvider>
	);
	const state = () => useTabsStore.getState();
	return {
		order: () => state().openTabs.map((t) => t.id),
		activeTabId: () => state().activeTabId,
		navIndex: () => state().navIndex,
		tabElement: (id: string) => document.getElementById(tabElementId(id)) as HTMLElement,
	};
}

/** A press of Alt+ArrowLeft on `target`, as the browser delivers it. */
const altLeft = (target: Element) =>
	fireEvent.keyDown(target, {
		key: "ArrowLeft",
		code: "ArrowLeft",
		altKey: true,
		bubbles: true,
	});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("Alt+Left off macOS, where it is also Go back", () => {
	it("moves a focused tab and does not navigate", async () => {
		const app = await mountOn("linux");
		const second = app.tabElement("t2");
		second.focus();
		expect(document.activeElement).toBe(second);

		altLeft(second);

		expect(app.order()).toEqual(["t2", "t1", "t3"]);
		expect(app.activeTabId()).toBe("t3");
		expect(app.navIndex()).toBe(2);
	});

	it("still goes back from anywhere else", async () => {
		const app = await mountOn("linux");
		expect(document.activeElement).toBe(document.body);

		altLeft(document.body);

		expect(app.navIndex()).toBe(1);
		expect(app.activeTabId()).toBe("t2");
		expect(app.order()).toEqual(["t1", "t2", "t3"]);
	});
});

describe("Alt+Left on macOS, where Go back is ⌘[", () => {
	it("moves a focused tab, and ⌘[ still goes back", async () => {
		const app = await mountOn("darwin");
		const second = app.tabElement("t2");
		second.focus();

		altLeft(second);
		expect(app.order()).toEqual(["t2", "t1", "t3"]);
		expect(app.navIndex()).toBe(2);

		fireEvent.keyDown(document.body, {
			key: "[",
			code: "BracketLeft",
			metaKey: true,
			bubbles: true,
		});
		expect(app.navIndex()).toBe(1);
	});

	it("does not read Alt+Left from elsewhere as Go back", async () => {
		const app = await mountOn("darwin");

		altLeft(document.body);

		expect(app.navIndex()).toBe(2);
		expect(app.activeTabId()).toBe("t3");
	});
});
