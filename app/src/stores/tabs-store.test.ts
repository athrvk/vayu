/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs-store";

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("closeTabsForEntities", () => {
	function openRequests(ids: string[]) {
		for (const id of ids) useTabsStore.getState().openTab({ type: "request", entityId: id });
	}

	it("closes a non-active tab and leaves the active tab focused", () => {
		openRequests(["a", "b", "c"]); // active becomes the last opened, "c"
		const activeBefore = useTabsStore.getState().activeTabId;

		useTabsStore.getState().closeTabsForEntities(["a"]);

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.map((t) => t.entityId)).toEqual(["b", "c"]);
		expect(activeTabId).toBe(activeBefore); // "c" still active
	});

	it("focuses the left neighbor when the active tab is closed", () => {
		openRequests(["a", "b", "c"]);
		// Focus the middle tab "b"
		const bTab = useTabsStore.getState().openTabs.find((t) => t.entityId === "b")!;
		useTabsStore.getState().focusTab(bTab.id);

		useTabsStore.getState().closeTabsForEntities(["b"]);

		const { openTabs, activeTabId } = useTabsStore.getState();
		const aTab = openTabs.find((t) => t.entityId === "a")!;
		expect(activeTabId).toBe(aTab.id); // left neighbor
	});

	it("closes several entities at once (e.g. a collection cascade)", () => {
		openRequests(["r1", "r2"]);
		useTabsStore.getState().openTab({ type: "collection", entityId: "col" });

		useTabsStore.getState().closeTabsForEntities(["col", "r1", "r2"]);

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
		expect(useTabsStore.getState().activeTabId).toBeNull();
	});

	it("never closes singleton tabs that have a null entityId", () => {
		useTabsStore.getState().openTab({ type: "welcome", entityId: null });
		openRequests(["a"]);

		useTabsStore.getState().closeTabsForEntities(["a"]);

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => t.type)).toEqual(["welcome"]);
	});

	it("is a no-op when nothing matches", () => {
		openRequests(["a", "b"]);
		const before = useTabsStore.getState();

		useTabsStore.getState().closeTabsForEntities(["nonexistent"]);

		expect(useTabsStore.getState().openTabs).toEqual(before.openTabs);
		expect(useTabsStore.getState().activeTabId).toBe(before.activeTabId);
	});
});
