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
 * Which drawer view the shell forces open when a tab becomes active.
 *
 * The rule reads the *tab type* and infers where that tab's entity lives. That
 * was sound while the collections tree was the only thing that opened a request
 * tab. It stopped being sound when History started opening them too - a design
 * run loads into the request builder - and the inference then threw the user out
 * of the run list on the first click, so working through several runs meant
 * reopening History between every one.
 *
 * Nothing covered this effect before, which is why that regression shipped as
 * far as a manual test. These are the four arrivals worth pinning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import Shell from "./Shell";
import { useLayoutStore, useTabsStore, type DrawerView, type TabType } from "@/stores";

// The shell mounts every screen and the whole drawer; none of that is the
// subject here, and all of it wants queries, editors and an engine.
vi.mock("./Drawer", () => ({ Drawer: () => <div data-testid="drawer" /> }));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar" /> }));
vi.mock("@/modules/collections/ImportModal", () => ({ ImportModal: () => null }));
vi.mock("@/modules/request-builder", () => ({ default: () => <div data-testid="builder" /> }));
vi.mock("@/modules/collections/CollectionDetail", () => ({ default: () => null }));
vi.mock("@/modules/dashboard", () => ({ default: () => null }));
vi.mock("@/modules/history/main", () => ({ HistoryDetail: () => <div data-testid="run" /> }));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({ default: () => null }));
vi.mock("@/modules/settings", () => ({ SettingsMain: () => null }));
vi.mock("@/modules/variables/main/VariablesMain", () => ({ default: () => null }));

/** Put the drawer on `from`, then make a tab of `type` the active one. */
function arriveAt(type: TabType, from: DrawerView): DrawerView {
	useLayoutStore.setState({ drawerView: from, drawerOpen: true });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type, entityId: "e1" }],
		activeTabId: "t1",
	});
	render(<Shell />);
	return useLayoutStore.getState().drawerView;
}

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("arriving at a request tab", () => {
	it("stays on History - that is where the design run came from", () => {
		// The regression: a design run opens the builder, so this branch started
		// firing on the main history-browsing path and ejected the user from the
		// list they were working through.
		expect(arriveAt("request", "history")).toBe("history");
	});

	it("still reveals the collections tree from anywhere else", () => {
		// Creating a request from the welcome screen, or opening the source
		// request of a load test - the drawer should show where it lives.
		expect(arriveAt("request", "variables")).toBe("collections");
	});

	it("is a no-op when the tree is already showing", () => {
		expect(arriveAt("request", "collections")).toBe("collections");
	});
});

describe("the other tab types are unchanged", () => {
	it("a run tab leaves the drawer alone", () => {
		// Never had a branch; an orphaned design run must not move the drawer
		// either, for the same reason a request tab must not.
		expect(arriveAt("run", "history")).toBe("history");
	});

	it("a variables tab still claims the variables list", () => {
		expect(arriveAt("variables", "history")).toBe("variables");
	});

	it("a settings tab still claims settings", () => {
		expect(arriveAt("settings", "history")).toBe("settings");
	});
});
