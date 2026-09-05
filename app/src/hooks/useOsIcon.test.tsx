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
 * What the Dock/taskbar icon's menu and badge need from the renderer (#1364):
 * the collections the user has been in, and when the Inbox is on screen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { TabLocation } from "@/stores";
import type { Collection } from "@/types";

interface FakeTab {
	id: string;
	type: string;
	entityId: string | null;
}

const tabsState: {
	navHistory: TabLocation[];
	openTabs: FakeTab[];
	activeTabId: string | null;
} = { navHistory: [], openTabs: [], activeTabId: null };

let collectionsData: Collection[] = [];

// `vi.hoisted` because the `vi.mock` factory below dereferences this at hoist
// time, which is before an ordinary `const` in this file has been initialised.
// The two factories above only *close over* their state and read it when called,
// which is why they need no such treatment.
const osIconMock = vi.hoisted(() => ({
	captured: vi.fn(),
	inboxOpened: vi.fn(),
	runFailed: vi.fn(),
	recents: vi.fn(),
}));

vi.mock("@/stores", () => ({
	useTabsStore: (selector: (s: typeof tabsState) => unknown) => selector(tabsState),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: collectionsData }),
}));

vi.mock("@/services/os-icon", () => ({ osIcon: osIconMock }));

import { useOsIcon, recentCollections } from "./useOsIcon";

function collection(id: string, name: string): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
	} as Collection;
}

function setTabs(overrides: Partial<typeof tabsState>): void {
	Object.assign(tabsState, { navHistory: [], openTabs: [], activeTabId: null, ...overrides });
}

beforeEach(() => {
	osIconMock.captured.mockReset();
	osIconMock.inboxOpened.mockReset();
	osIconMock.runFailed.mockReset();
	osIconMock.recents.mockReset();
	collectionsData = [];
	setTabs({});
});

describe("recentCollections", () => {
	const collections = [collection("c1", "Acme"), collection("c2", "Beta")];

	it("orders most recently visited first", () => {
		const history: TabLocation[] = [
			{ type: "collection", entityId: "c1" },
			{ type: "collection", entityId: "c2" },
		];
		expect(recentCollections(history, collections, 8)).toEqual([
			{ id: "c2", name: "Beta" },
			{ id: "c1", name: "Acme" },
		]);
	});

	it("dedupes a collection visited twice, keeping its most recent slot", () => {
		// Mutation check: drop the `seen` set and c1 appears twice, at both the
		// position it was first visited and the position it was revisited.
		const history: TabLocation[] = [
			{ type: "collection", entityId: "c1" },
			{ type: "collection", entityId: "c2" },
			{ type: "collection", entityId: "c1" },
		];
		expect(recentCollections(history, collections, 8)).toEqual([
			{ id: "c1", name: "Acme" },
			{ id: "c2", name: "Beta" },
		]);
	});

	it("skips a location that is not a collection tab, and a collection tab with no entity", () => {
		// Mutation check: drop either half of the guard and a request tab or a
		// blank collection singleton shows up as a named entry on the menu.
		const history: TabLocation[] = [
			{ type: "request", entityId: "r1" },
			{ type: "collection", entityId: null },
			{ type: "collection", entityId: "c1" },
		];
		expect(recentCollections(history, collections, 8)).toEqual([{ id: "c1", name: "Acme" }]);
	});

	it("skips an id the live collections list no longer holds", () => {
		// Mutation check: drop the `collections.find` guard and a deleted
		// collection's last-known name lands on the Dock menu, opening nothing
		// when clicked.
		const history: TabLocation[] = [{ type: "collection", entityId: "gone" }];
		expect(recentCollections(history, collections, 8)).toEqual([]);
	});

	it("stops at the limit", () => {
		const history: TabLocation[] = [
			{ type: "collection", entityId: "c1" },
			{ type: "collection", entityId: "c2" },
		];
		expect(recentCollections(history, collections, 1)).toEqual([{ id: "c2", name: "Beta" }]);
	});
});

describe("useOsIcon", () => {
	it("publishes the recents derived from history and the live collections", () => {
		collectionsData = [collection("c1", "Acme")];
		setTabs({ navHistory: [{ type: "collection", entityId: "c1" }] });

		renderHook(() => useOsIcon());

		expect(osIconMock.recents).toHaveBeenCalledWith([{ id: "c1", name: "Acme" }]);
	});

	it("says the Inbox opened once the inbox tab becomes the active one", () => {
		setTabs({ openTabs: [{ id: "t1", type: "request", entityId: null }], activeTabId: "t1" });
		const { rerender } = renderHook(() => useOsIcon());
		expect(osIconMock.inboxOpened).not.toHaveBeenCalled();

		setTabs({
			openTabs: [{ id: "t2", type: "inbox", entityId: "inbox_a" }],
			activeTabId: "t2",
		});
		rerender();

		expect(osIconMock.inboxOpened).toHaveBeenCalledTimes(1);
	});

	it("says the Inbox opened again on every window focus while it is on screen", () => {
		// Mutation check: drop the `focus` listener and this reddens - main
		// counts a capture on every unfocus regardless of what the window shows
		// on the way back, so a user who returns straight to the Inbox tab would
		// keep a badge for captures already on their screen (#1364).
		setTabs({
			openTabs: [{ id: "t1", type: "inbox", entityId: "inbox_a" }],
			activeTabId: "t1",
		});
		renderHook(() => useOsIcon());
		osIconMock.inboxOpened.mockClear();

		act(() => window.dispatchEvent(new Event("focus")));
		act(() => window.dispatchEvent(new Event("focus")));

		expect(osIconMock.inboxOpened).toHaveBeenCalledTimes(2);
	});

	it("does not answer a window focus while the Inbox is not on screen", () => {
		// Mutation check: drop the `inboxOnScreen` guard around the listener and
		// a focus anywhere in the app - not just a return to the Inbox tab -
		// clears whatever badge the OS is showing.
		setTabs({ openTabs: [{ id: "t1", type: "request", entityId: null }], activeTabId: "t1" });
		renderHook(() => useOsIcon());
		osIconMock.inboxOpened.mockClear();

		act(() => window.dispatchEvent(new Event("focus")));

		expect(osIconMock.inboxOpened).not.toHaveBeenCalled();
	});

	it("stops listening for focus once unmounted", () => {
		setTabs({
			openTabs: [{ id: "t1", type: "inbox", entityId: "inbox_a" }],
			activeTabId: "t1",
		});
		const { unmount } = renderHook(() => useOsIcon());
		osIconMock.inboxOpened.mockClear();

		unmount();
		act(() => window.dispatchEvent(new Event("focus")));

		expect(osIconMock.inboxOpened).not.toHaveBeenCalled();
	});
});
