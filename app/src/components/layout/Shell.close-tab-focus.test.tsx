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
 * The close-tab chord's other half: where focus is once the tab is gone.
 *
 * `Shell.chords.test.tsx` renders the strip as a stub, which is right for a file
 * about which chord changes which store - and no use at all for this, because
 * the tab that has to end up focused is a real element the strip renders. So
 * this file mounts the same Shell with the real `TabStrip`, and nothing else.
 *
 * The chord fires wherever focus is, and what it closes is usually the panel
 * holding it. Nothing claimed focus afterwards, so it fell to `<body>` and the
 * next Tab restarted from the top of the document (#1218).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { tabElementId } from "./tab-aria";
import { useTabsStore } from "@/stores";

// Every surface Shell can mount, stubbed - the strip is the one real thing
// here. Same list as Shell.chords.test.tsx, minus the TabStrip stub.
vi.mock("./Drawer", () => ({ Drawer: () => <div data-testid="drawer" /> }));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar" /> }));
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

function renderShell() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<Shell />
		</QueryClientProvider>
	);
}

/** The chord itself, as the window handler sees it. Ctrl is the half that
 *  matches on every platform the suite runs on. */
const pressCloseTab = () =>
	fireEvent.keyDown(document.body, { key: "w", ctrlKey: true, bubbles: true });

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [
			{ id: "t1", type: "welcome", entityId: null },
			{ id: "t2", type: "settings", entityId: null },
		],
		activeTabId: "t2",
	});
});

describe("the close-tab chord", () => {
	it("leaves focus on the tab that replaces the closed one", () => {
		renderShell();
		// Focus starts outside the strip, which is the whole point of a chord -
		// it is pressed from inside the panel the tab is showing.
		expect(document.activeElement).toBe(document.body);

		pressCloseTab();

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(document.activeElement).toBe(document.getElementById(tabElementId("t1")));
	});

	it("falls back to the New tab button when it closes the last tab", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "welcome", entityId: null }],
			activeTabId: "t1",
		});
		const { getByLabelText } = renderShell();

		pressCloseTab();

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
		expect(document.activeElement).toBe(getByLabelText("New tab"));
	});
});
