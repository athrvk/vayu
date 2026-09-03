/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The navigation history - Back and Forward over tab activations (#1245).
 *
 * The behaviours pinned here are the ones a hand-rolled history gets wrong:
 * that the two traversals move the cursor rather than extend the stack, that a
 * location outlives the tab that showed it, and that a deleted entity leaves
 * the history at the moment it is deleted rather than being discovered later by
 * a pane rendering an error.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { canGoBack, canGoForward, useTabsStore, type TabLocation } from "./tabs-store";
import { useSaveStore } from "./save-store";

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
function visitRequests(...ids: string[]) {
	for (const id of ids) store().openTab({ type: "request", entityId: id });
}

/** The history as `type:entityId` strings, which read better in a failure. */
function history(): string[] {
	return store().navHistory.map((l: TabLocation) => `${l.type}:${l.entityId}`);
}

/** The entity the active tab is showing. */
function activeEntity(): string | null | undefined {
	const { openTabs, activeTabId } = store();
	return openTabs.find((t) => t.id === activeTabId)?.entityId;
}

describe("recording where the user has been", () => {
	it("records every activation, in order", () => {
		visitRequests("a", "b", "c");
		expect(history()).toEqual(["request:a", "request:b", "request:c"]);
		expect(store().navIndex).toBe(2);
	});

	it("coalesces a repeat of the place already showing", () => {
		visitRequests("a", "b");
		store().openTab({ type: "request", entityId: "b" });
		store().focusTab(store().activeTabId!);
		expect(history()).toEqual(["request:a", "request:b"]);
	});

	it("records a focus of an already-open tab", () => {
		visitRequests("a", "b");
		const first = store().openTabs[0];
		store().focusTab(first.id);
		expect(history()).toEqual(["request:a", "request:b", "request:a"]);
		expect(store().navIndex).toBe(2);
	});

	it("records a singleton by what it was pointed at, not by what it was showing", () => {
		store().openTab({ type: "inbox", entityId: "inbox-1" });
		store().openTab({ type: "inbox", entityId: "inbox-2" });
		expect(history()).toEqual(["inbox:inbox-1", "inbox:inbox-2"]);
		// One tab, retargeted - the dedupe this store already had.
		expect(store().openTabs).toHaveLength(1);
	});

	it("holds the cap by dropping the oldest step", () => {
		visitRequests(...Array.from({ length: 60 }, (_, i) => `r${i}`));
		expect(store().navHistory).toHaveLength(50);
		expect(history()[0]).toBe("request:r10");
		expect(store().navIndex).toBe(49);
	});
});

describe("going back and forward", () => {
	it("walks back through the places visited, and returns", () => {
		visitRequests("a", "b", "c");

		store().goBack();
		expect(activeEntity()).toBe("b");
		store().goBack();
		expect(activeEntity()).toBe("a");
		store().goForward();
		expect(activeEntity()).toBe("b");
	});

	/*
	 * The mutation check for `traversingHistory`: without the guard each
	 * traversal records its own arrival, so this history would grow past three
	 * and the cursor would sit at its end with nothing ahead of it.
	 */
	it("moves the cursor rather than extending the history", () => {
		visitRequests("a", "b", "c");

		store().goBack();
		store().goBack();
		store().goForward();

		expect(history()).toEqual(["request:a", "request:b", "request:c"]);
		expect(store().navIndex).toBe(1);
		expect(canGoForward(store())).toBe(true);
	});

	it("truncates the forward half when the user goes somewhere new", () => {
		visitRequests("a", "b", "c");
		store().goBack(); // at "b", with "c" ahead

		visitRequests("d");

		expect(history()).toEqual(["request:a", "request:b", "request:d"]);
		expect(canGoForward(store())).toBe(false);
	});

	it("does nothing at either end", () => {
		visitRequests("a");
		expect(canGoBack(store())).toBe(false);
		expect(canGoForward(store())).toBe(false);

		store().goBack();
		store().goForward();

		expect(activeEntity()).toBe("a");
		expect(history()).toEqual(["request:a"]);
	});

	it("reopens a tab that was closed, as a new tab at the same place", () => {
		visitRequests("a", "b");
		const closed = store().openTabs.find((t) => t.entityId === "a")!;
		store().closeTab(closed.id);
		store().openTab({ type: "request", entityId: "c" });

		store().goBack(); // "b"
		store().goBack(); // "a", whose tab is gone

		expect(activeEntity()).toBe("a");
		expect(store().openTabs.find((t) => t.entityId === "a")?.id).not.toBe(closed.id);
	});

	it("reopens a closed singleton as one tab, not a second copy", () => {
		store().openTab({ type: "variables", entityId: null });
		visitRequests("a");
		const variables = store().openTabs.find((t) => t.type === "variables")!;
		store().closeTab(variables.id);

		store().goBack();

		expect(store().openTabs.filter((t) => t.type === "variables")).toHaveLength(1);
		expect(store().openTabs.find((t) => t.id === store().activeTabId)?.type).toBe("variables");
	});
});

describe("closing the active tab", () => {
	it("returns to the previous place while its tab is still open", () => {
		visitRequests("a", "b", "c");
		// Strip order is a, b, c - so the left neighbour of "c" is "b" either
		// way. Go back to "a" first, then open "d": the place before "d" is "a",
		// while "d"'s left neighbour in the strip is "c".
		store().goBack();
		store().goBack();
		visitRequests("d");

		store().closeTab(store().activeTabId!);

		expect(activeEntity()).toBe("a");
	});

	it("falls back to the neighbour when nothing behind it is open", () => {
		visitRequests("a", "b");
		const a = store().openTabs.find((t) => t.entityId === "a")!;
		store().closeTab(a.id); // not active: "b" stays

		store().closeTab(store().activeTabId!);

		expect(store().openTabs).toHaveLength(0);
		expect(store().activeTabId).toBeNull();
	});

	it("leaves the closed place ahead of the cursor, so Forward reopens it", () => {
		visitRequests("a", "b");
		store().closeTab(store().activeTabId!); // closes "b", lands on "a"
		expect(activeEntity()).toBe("a");

		store().goForward();

		expect(activeEntity()).toBe("b");
	});

	it("does not move the cursor when the closed tab was not the active one", () => {
		visitRequests("a", "b");
		const a = store().openTabs.find((t) => t.entityId === "a")!;

		store().closeTab(a.id);

		expect(activeEntity()).toBe("b");
		expect(store().navIndex).toBe(1);
	});
});

describe("a deleted entity leaves the history", () => {
	it("drops the places it was, whether or not a tab is showing one", () => {
		visitRequests("a", "b", "c");
		const b = store().openTabs.find((t) => t.entityId === "b")!;
		store().closeTab(b.id); // "b" is only in the history now

		store().closeTabsForEntities(["b"]);

		expect(history()).toEqual(["request:a", "request:c"]);
	});

	it("keeps the cursor on the place the user is at", () => {
		visitRequests("a", "b", "c");
		store().goBack(); // at "b"

		store().closeTabsForEntities(["a"]);

		expect(history()).toEqual(["request:b", "request:c"]);
		expect(store().navIndex).toBe(0);
		expect(canGoBack(store())).toBe(false);
		expect(canGoForward(store())).toBe(true);
	});

	it("never goes back to a deleted entity", () => {
		visitRequests("a", "b", "c");
		store().closeTabsForEntities(["b"]);

		store().goBack();

		expect(activeEntity()).toBe("a");
	});

	/*
	 * The case where the cursor itself is deleted and everything behind it goes
	 * with it. What survives is ahead, and it has to stay reachable: those
	 * entries name tabs that are still open, so a history that forgot them would
	 * grey out Forward while the tab it leads to is on screen.
	 */
	it("keeps the places ahead when the one the user is at is deleted", () => {
		visitRequests("a", "b", "c");
		store().goBack();
		store().goBack(); // at "a", with "b" and "c" ahead

		store().closeTabsForEntities(["a"]);

		expect(history()).toEqual(["request:b", "request:c"]);
		expect(activeEntity()).toBe("b");
		expect(canGoForward(store())).toBe(true);

		store().goForward();
		expect(activeEntity()).toBe("c");
	});

	it("records the survivor the deletion focused", () => {
		visitRequests("a", "b");
		store().closeTabsForEntities(["b"]); // the active tab goes with it

		expect(activeEntity()).toBe("a");
		expect(history()).toEqual(["request:a"]);
		expect(store().navIndex).toBe(0);
	});

	it("respects the type narrowing the sweep carries", () => {
		visitRequests("a");
		store().openTab({ type: "run", entityId: "a" });

		store().closeTabsForEntities(["a"], "run");

		expect(history()).toEqual(["request:a"]);
	});
});

describe("what the controls read", () => {
	it("offers nothing to go back to before anything has been visited", () => {
		expect(canGoBack(store())).toBe(false);
		expect(canGoForward(store())).toBe(false);
	});

	it("offers Back once there is somewhere behind", () => {
		visitRequests("a", "b");
		expect(canGoBack(store())).toBe(true);
		expect(canGoForward(store())).toBe(false);
	});
});
