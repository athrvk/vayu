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
 * What the palette promises: the chord reaches it from anywhere, typing part of
 * a name finds the thing, Enter opens it, and Escape puts focus back where it
 * was.
 *
 * Two of those are guards against a specific way of failing:
 *
 * - **Capture phase.** Monaco consumes ⌘K as a chord prefix and stops it
 *   propagating, so a bubble-phase listener never sees the key while the caret
 *   is in an editor. The test dispatches through an element that calls
 *   `stopPropagation`, which is what an editor does; move the listener to the
 *   bubble and it fails.
 * - **Focus restoration.** Radix restores to a dialog's trigger, and a palette
 *   opened by a chord has none, so the module captures and restores it itself.
 *   Drop that and this fails with focus on `<body>` - which is what it did
 *   before the capture was added.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CommandPalette } from "./CommandPalette";
import { useLayoutStore, useTabsStore } from "@/stores";

const COLLECTIONS = [
	{ id: "c1", name: "Payments", parentId: undefined },
	{ id: "c2", name: "Auth", parentId: "c1" },
];

const REQUESTS = new Map([
	[
		"c1",
		[
			{ id: "r1", collectionId: "c1", name: "Charge card", method: "POST", url: "/charges" },
			{ id: "r2", collectionId: "c1", name: "Refund", method: "POST", url: "/refunds" },
		],
	],
	["c2", [{ id: "r3", collectionId: "c2", name: "Issue token", method: "GET", url: "/token" }]],
]);

/** Runs, newest-first, as the infinite query hands them over. */
let runPages: { data: { id: string; requestId: string | null; startTime: number }[] }[] = [
	{ data: [] },
];

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: COLLECTIONS }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: REQUESTS, isLoading: false }),
	useRunsQuery: () => ({ data: { pages: runPages } }),
	flattenRunPages: (data?: { pages: { data: unknown[] }[] }) =>
		data ? data.pages.flatMap((p) => p.data) : [],
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderPalette() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			{/* A focusable neighbour, so "focus goes back where it was" has
			    somewhere to go back to. */}
			<input aria-label="outside" />
			<CommandPalette />
		</QueryClientProvider>
	);
}

/** Dispatch ⌘K the way an editor does: swallowed before it can bubble. */
function pressPaletteChordInsideAnEditor() {
	const editor = document.createElement("div");
	editor.addEventListener("keydown", (e) => e.stopPropagation());
	document.body.appendChild(editor);
	act(() =>
		editor.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			})
		)
	);
	editor.remove();
}

/** Open it the way the store does, inside `act` so the dialog mounts. */
function open() {
	act(() => useLayoutStore.getState().setPaletteOpen(true));
}

/** The palette's search field. */
function input(): HTMLInputElement {
	return screen.getByPlaceholderText(/Search tabs/) as HTMLInputElement;
}

function typeQuery(text: string) {
	fireEvent.change(input(), { target: { value: text } });
}

/** Enter on the highlighted row - cmdk handles the key on its root. */
function pressEnter() {
	fireEvent.keyDown(input(), { key: "Enter" });
}

beforeEach(() => {
	// cmdk scrolls the highlighted row into view; jsdom has no such method.
	Element.prototype.scrollIntoView = vi.fn();
	runPages = [{ data: [] }];
	useLayoutStore.setState({ paletteOpen: false, drawerOpen: false, drawerView: "collections" });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
});
afterEach(cleanup);

describe("the ⌘K chord", () => {
	it("opens the palette even when an editor swallows the key", () => {
		renderPalette();
		pressPaletteChordInsideAnEditor();
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});

	it("closes it again, so the chord that opened it dismisses it", () => {
		renderPalette();
		pressPaletteChordInsideAnEditor();
		pressPaletteChordInsideAnEditor();
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("ignores the key without the modifier, and ⇧⌘K", () => {
		renderPalette();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "K", metaKey: true, shiftKey: true, bubbles: true })
		);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("matches the chord under Caps Lock, which reports an upper-case key", () => {
		renderPalette();
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "K", metaKey: true, bubbles: true })
		);
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});
});

describe("searching", () => {
	it("finds a request by part of its name and opens its tab on Enter", async () => {
		renderPalette();
		open();

		typeQuery("refu");
		pressEnter();

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0]).toMatchObject({ type: "request", entityId: "r2" });
		expect(activeTabId).toBe(openTabs[0].id);
		// A pick always closes it - a palette left open over the thing it just
		// opened is in the way.
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});

	it("finds a request by its URL, which its name need not mention", async () => {
		renderPalette();
		open();

		typeQuery("/token");
		expect(screen.getByText("Issue token")).toBeInTheDocument();
		expect(screen.queryByText("Charge card")).not.toBeInTheDocument();
	});

	it("shows a collection's path, so two same-named requests are told apart", async () => {
		renderPalette();
		open();
		// "Auth" is nested under "Payments", and its request says so.
		expect(screen.getByText("Payments / Auth")).toBeInTheDocument();
	});

	it("says so when nothing matches", async () => {
		renderPalette();
		open();
		typeQuery("zzzzz");
		expect(screen.getByText("No matches.")).toBeInTheDocument();
	});

	it("switches to an open tab rather than opening a second one", async () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "settings", entityId: null },
				{ id: "t2", type: "inbox", entityId: null },
			],
			activeTabId: "t2",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		typeQuery("Settings");
		pressEnter();

		const state = useTabsStore.getState();
		expect(state.openTabs).toHaveLength(2);
		expect(state.activeTabId).toBe("t1");
	});
});

describe("the empty query", () => {
	it("puts the most recently focused tab first", async () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "t1", type: "settings", entityId: null },
				{ id: "t2", type: "inbox", entityId: null },
				{ id: "t3", type: "variables", entityId: null },
			],
			activeTabId: "t1",
			// Insertion order is t1, t2, t3; attention order is t2, t3, t1.
			tabFocusedAt: { t1: 1000, t2: 3000, t3: 2000 },
		});
		renderPalette();
		open();

		const tabsGroup = screen.getByText("Tabs").closest("[cmdk-group]")!;
		const labels = [...tabsGroup.querySelectorAll("[cmdk-item]")].map(
			(el) => el.querySelector("span.flex-1")?.textContent
		);
		expect(labels).toEqual(["Inbox", "Variables", "Settings"]);
	});

	it("puts the most recently sent request first", async () => {
		runPages = [
			{
				data: [
					{ id: "run2", requestId: "r2", startTime: 5000 },
					{ id: "run1", requestId: "r1", startTime: 1000 },
				],
			},
		];
		renderPalette();
		open();

		const group = screen.getByText("Requests").closest("[cmdk-group]")!;
		const labels = [...group.querySelectorAll("[cmdk-item]")].map(
			(el) => el.querySelector("span.flex-1")?.textContent
		);
		// Tree order is Charge card, Refund, Issue token; Refund ran last.
		expect(labels[0]).toBe("Refund");
	});

	it("keeps the groups in a fixed order", async () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "settings", entityId: null }],
			activeTabId: "t1",
			tabFocusedAt: {},
		});
		renderPalette();
		open();

		expect(screen.getByText("Tabs")).toBeInTheDocument();
		const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
			(el) => el.textContent
		);
		expect(headings).toEqual(["Tabs", "Requests", "Collections", "Views"]);
	});
});

describe("closing", () => {
	it("puts focus back where it was", async () => {
		renderPalette();
		const outside = screen.getByLabelText("outside");
		outside.focus();
		expect(document.activeElement).toBe(outside);

		open();
		expect(input()).toBeInTheDocument();
		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(useLayoutStore.getState().paletteOpen).toBe(false));
		await waitFor(() => expect(document.activeElement).toBe(outside));
	});

	it("starts empty on the next open rather than restoring the last query", async () => {
		renderPalette();
		open();
		typeQuery("refu");
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(useLayoutStore.getState().paletteOpen).toBe(false));

		pressPaletteChordInsideAnEditor();
		expect(input().value).toBe("");
	});
});

describe("cost", () => {
	it("renders no results at all while shut", () => {
		renderPalette();
		expect(screen.queryByText("Views")).not.toBeInTheDocument();
	});
});
