/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The strip's bulk closes - Close Others, Close to the Right, Close Saved
 * (#1360).
 *
 * What these pin is that a bulk close is *one* close: one publication, one
 * replacement for the tab that was showing, and at most one recorded visit.
 * Written as a loop over `closeTab` all three would still leave the right tabs
 * open, and every case below that counts a publication or reads the history
 * would fail - which is the point of counting them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabsStore, type TabLocation } from "./tabs-store";
import { useSaveStore, type SaveContext } from "./save-store";

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [],
		activeTabId: null,
		tabFocusedAt: {},
		navHistory: [],
		navIndex: -1,
	});
	useSaveStore.setState({ contexts: new Map() });
});

const store = () => useTabsStore.getState();

/** Open request tabs in order, leaving the last one active. */
function openRequests(...ids: string[]) {
	for (const id of ids) store().openTab({ type: "request", entityId: id });
}

/** The open tabs by entity, which reads better in a failure than ids do. */
function openEntities(): (string | null)[] {
	return store().openTabs.map((t) => t.entityId);
}

/** The entity the active tab is showing. */
function activeEntity(): string | null | undefined {
	const { openTabs, activeTabId } = store();
	return openTabs.find((t) => t.id === activeTabId)?.entityId;
}

/** The id of the tab showing `entityId`. */
function tabId(entityId: string): string {
	const tab = store().openTabs.find((t) => t.entityId === entityId);
	if (!tab) throw new Error(`No open tab for ${entityId}`);
	return tab.id;
}

/** The history as `type:entityId` strings, the shape the navigation tests use. */
function history(): string[] {
	return store().navHistory.map((l: TabLocation) => `${l.type}:${l.entityId}`);
}

/** Register a dirty save context the way the editors do. */
function markDirty(contextId: string) {
	const context: SaveContext = {
		id: contextId,
		name: contextId,
		save: () => Promise.resolve(),
		hasPendingChanges: true,
	};
	useSaveStore.getState().registerContext(context);
}

/** How many times the store published while `act` ran. */
function publications(act: () => void): number {
	let count = 0;
	const stop = useTabsStore.subscribe(() => {
		count += 1;
	});
	try {
		act();
	} finally {
		stop();
	}
	return count;
}

describe("closeOtherTabs", () => {
	it("leaves only the named tab, and shows it", () => {
		openRequests("a", "b", "c");

		store().closeOtherTabs(tabId("b"));

		expect(openEntities()).toEqual(["b"]);
		expect(activeEntity()).toBe("b");
	});

	it("keeps the active tab active when it is the one kept", () => {
		openRequests("a", "b", "c"); // "c" is active
		const active = store().activeTabId;

		store().closeOtherTabs(tabId("c"));

		expect(store().activeTabId).toBe(active);
	});

	it("closes the whole set in one publication, not one per tab", () => {
		openRequests("a", "b", "c", "d");

		const updates = publications(() => store().closeOtherTabs(tabId("a")));

		expect(updates).toBe(1);
		expect(openEntities()).toEqual(["a"]);
	});

	it("is a no-op for a tab that is not open, and for the only open tab", () => {
		openRequests("a");

		expect(publications(() => store().closeOtherTabs("no-such-tab"))).toBe(0);
		expect(publications(() => store().closeOtherTabs(tabId("a")))).toBe(0);
		expect(openEntities()).toEqual(["a"]);
	});
});

describe("closeTabsToRight", () => {
	it("keeps the tabs up to and including the named one", () => {
		openRequests("a", "b", "c", "d");

		store().closeTabsToRight(tabId("b"));

		expect(openEntities()).toEqual(["a", "b"]);
	});

	it("shows the named tab when the active tab was to its right", () => {
		openRequests("a", "b", "c"); // "c" is active, and is closing

		store().closeTabsToRight(tabId("a"));

		expect(activeEntity()).toBe("a");
	});

	it("leaves the active tab alone when it is to the left", () => {
		openRequests("a", "b", "c");
		store().focusTab(tabId("a"));

		store().closeTabsToRight(tabId("b"));

		expect(openEntities()).toEqual(["a", "b"]);
		expect(activeEntity()).toBe("a");
	});

	it("is a no-op on the last tab in the strip", () => {
		openRequests("a", "b");

		expect(publications(() => store().closeTabsToRight(tabId("b")))).toBe(0);
	});
});

describe("closeSavedTabs", () => {
	it("closes the clean tabs and keeps the dirty one", () => {
		openRequests("clean", "dirty", "also-clean");
		markDirty("request-dirty");

		store().closeSavedTabs();

		expect(openEntities()).toEqual(["dirty"]);
		expect(activeEntity()).toBe("dirty");
	});

	it("reads the same dirty answer as eviction does, for a tab with no entityId", () => {
		// Settings registers as "settings" and has no entityId to look up - the
		// case a `request-${id}` lookup reports clean, taking the edits with it.
		openRequests("a");
		store().openTab({ type: "settings", entityId: null });
		markDirty("settings");

		store().closeSavedTabs();

		expect(store().openTabs.map((t) => t.type)).toEqual(["settings"]);
	});

	it("is a no-op when every open tab is dirty", () => {
		openRequests("one", "two");
		markDirty("request-one");
		markDirty("request-two");

		expect(publications(() => store().closeSavedTabs())).toBe(0);
		expect(openEntities()).toEqual(["one", "two"]);
	});

	it("empties the strip when nothing is dirty", () => {
		openRequests("a", "b");

		store().closeSavedTabs();

		expect(store().openTabs).toHaveLength(0);
		expect(store().activeTabId).toBeNull();
	});
});

describe("what a bulk close does to the history", () => {
	it("records nothing when the survivor is somewhere the user has been", () => {
		openRequests("a", "b", "c"); // history: a, b, c - cursor on c
		const before = history();

		store().closeOtherTabs(tabId("a"));

		expect(history()).toEqual(before);
		expect(store().navIndex).toBe(0); // the cursor moved to where "a" is
		expect(activeEntity()).toBe("a");
	});

	it("records one visit when the survivor is not behind the cursor", () => {
		openRequests("a", "b");
		store().goBack(); // cursor on "a"
		openRequests("c"); // truncates the forward half: history is a, c
		expect(history()).toEqual(["request:a", "request:c"]);

		// "b" is still open but no longer in the history, so closing everything
		// else leaves the user somewhere the history does not name.
		store().closeOtherTabs(tabId("b"));

		expect(activeEntity()).toBe("b");
		expect(history()).toEqual(["request:a", "request:c", "request:b"]);
		expect(store().navIndex).toBe(2);
	});

	it("keeps a closed tab reachable through Back", () => {
		openRequests("a", "b", "c");

		store().closeTabsToRight(tabId("a"));
		expect(openEntities()).toEqual(["a"]);

		store().goForward();

		expect(activeEntity()).toBe("b"); // reopened by the history, as a browser does
	});
});

/**
 * A tab a close brings on screen is being focused, so it is stamped like any
 * other focus: the palette lists open tabs by the stamp and LRU eviction takes
 * the lowest one, and the tab the user is looking at must not rank below the
 * ones they are not.
 */
describe("what a close does to the focus stamps", () => {
	let clock = 0;
	const tick = () => vi.setSystemTime((clock += 10));

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		clock = 1_000;
		vi.setSystemTime(clock);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Open request tabs one tick apart, so every stamp is distinct. */
	function openSpaced(...ids: string[]) {
		for (const id of ids) {
			tick();
			openRequests(id);
		}
	}

	const newestStamp = () => Math.max(...Object.values(store().tabFocusedAt));

	it("stamps the tab the history walks back to", () => {
		openSpaced("a", "b", "c"); // history a, b, c - closing "c" lands on "b"
		const before = store().tabFocusedAt[tabId("b")];

		tick();
		store().closeTab(tabId("c"));

		expect(activeEntity()).toBe("b");
		expect(store().tabFocusedAt[tabId("b")]).toBeGreaterThan(before);
		expect(store().tabFocusedAt[tabId("b")]).toBe(newestStamp());
	});

	it("stamps the nearest survivor when the history names nothing that is open", () => {
		openSpaced("a", "b");
		store().goBack();
		openSpaced("c"); // history a, c; "b" is open but outside it
		const before = store().tabFocusedAt[tabId("b")];

		tick();
		store().closeOtherTabs(tabId("b"));

		expect(activeEntity()).toBe("b");
		expect(store().tabFocusedAt[tabId("b")]).toBeGreaterThan(before);
		expect(Object.keys(store().tabFocusedAt)).toEqual([tabId("b")]);
	});

	it("leaves the stamps alone when the tab in view is staying", () => {
		openSpaced("a", "b", "c");
		const before = store().tabFocusedAt;

		store().closeTab(tabId("a"));

		expect(store().tabFocusedAt[tabId("c")]).toBe(before[tabId("c")]);
	});
});
