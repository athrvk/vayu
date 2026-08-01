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
 * Which collection is "in scope" is a question with two different answers
 * depending on what the user is looking at, and the Monaco completion providers
 * got it wrong by not asking at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const tabs: {
	openTabs: Array<{ id: string; type: string; entityId: string | null }>;
	activeTabId: string | null;
} = { openTabs: [], activeTabId: null };

const requests: Record<string, { id: string; collectionId: string }> = {
	r1: { id: "r1", collectionId: "c1" },
};

/** Records what `useRequestQuery` was asked for, so we can prove it is not asked pointlessly. */
const requested: Array<string | null> = [];

vi.mock("@/stores", () => ({
	useTabsStore: () => tabs,
}));

vi.mock("@/queries", () => ({
	useRequestQuery: (id: string | null) => {
		requested.push(id);
		return { data: id ? requests[id] : undefined };
	},
}));

import { useActiveCollectionId } from "./useActiveCollectionId";

function activeCollection() {
	return renderHook(() => useActiveCollectionId()).result.current;
}

beforeEach(() => {
	tabs.openTabs = [];
	tabs.activeTabId = null;
	requested.length = 0;
});

describe("useActiveCollectionId", () => {
	it("gives a request tab the collection its request belongs to", () => {
		tabs.openTabs = [{ id: "t1", type: "request", entityId: "r1" }];
		tabs.activeTabId = "t1";
		expect(activeCollection()).toBe("c1");
	});

	it("gives a collection tab the collection itself", () => {
		// The Collection Detail script panels are Monaco editors too, and their
		// scope is the collection on screen - there is no request in play.
		tabs.openTabs = [{ id: "t2", type: "collection", entityId: "c9" }];
		tabs.activeTabId = "t2";
		expect(activeCollection()).toBe("c9");
		// No request to look up, so none should be requested.
		expect(requested).toEqual([null]);
	});

	it("gives a tab with no collection nothing rather than a stale one", () => {
		tabs.openTabs = [{ id: "t3", type: "settings", entityId: null }];
		tabs.activeTabId = "t3";
		expect(activeCollection()).toBeUndefined();
	});

	it("gives nothing while the request is still loading", () => {
		tabs.openTabs = [{ id: "t4", type: "request", entityId: "unknown" }];
		tabs.activeTabId = "t4";
		expect(activeCollection()).toBeUndefined();
	});
});
