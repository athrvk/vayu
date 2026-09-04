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
 * A tab's right-click menu (#1360).
 *
 * The strip had one action on a tab - close, by middle-click or by the X - so
 * "close the eight tabs I am done with" was eight gestures. These cases drive
 * the menu on the real strip: what it offers, that each item closes exactly the
 * set its label names, and that a tab is marked so the main process draws no
 * edit menu over it.
 *
 * Tabs are singletons so no request query is involved - the same reason
 * `TabStrip.keyboard.test.tsx` picks them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import { useTabsStore, useSaveStore } from "@/stores";
import type { SaveContext } from "@/stores/save-store";

function renderStrip() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TabStrip />
		</QueryClientProvider>
	);
}

const TABS = [
	{ id: "t1", type: "welcome" as const, entityId: null },
	{ id: "t2", type: "settings" as const, entityId: null },
	{ id: "t3", type: "variables" as const, entityId: null },
];

const tab = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
const openTabIds = () => useTabsStore.getState().openTabs.map((t) => t.id);

/** Right-click a tab - the same event the Menu key and Shift+F10 raise. */
async function openMenuOn(id: string) {
	fireEvent.contextMenu(tab(id));
	return screen.findByRole("menu");
}

async function choose(name: string) {
	fireEvent.click(await screen.findByRole("menuitem", { name }));
}

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [...TABS],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
	useSaveStore.setState({ contexts: new Map() });
});

describe("a tab's right-click menu", () => {
	it("offers the four closes", async () => {
		renderStrip();

		const menu = await openMenuOn("t2");

		expect(menu).toBeInTheDocument();
		for (const label of ["Close", "Close Others", "Close to the Right", "Close Saved"]) {
			expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
		}
	});

	it("closes the tab it opened over", async () => {
		renderStrip();

		await openMenuOn("t2");
		await choose("Close");

		await waitFor(() => expect(openTabIds()).toEqual(["t1", "t3"]));
	});

	it("leaves only the tab it opened over on Close Others", async () => {
		renderStrip();

		await openMenuOn("t2");
		await choose("Close Others");

		await waitFor(() => expect(openTabIds()).toEqual(["t2"]));
	});

	it("keeps the tabs up to and including this one on Close to the Right", async () => {
		renderStrip();

		await openMenuOn("t2");
		await choose("Close to the Right");

		await waitFor(() => expect(openTabIds()).toEqual(["t1", "t2"]));
	});

	it("keeps a tab with unsaved edits on Close Saved", async () => {
		const dirty: SaveContext = {
			id: "settings",
			name: "settings",
			save: () => Promise.resolve(),
			hasPendingChanges: true,
		};
		useSaveStore.getState().registerContext(dirty);
		renderStrip();

		await openMenuOn("t1");
		await choose("Close Saved");

		// t2 is the Settings tab, whose editor is the dirty one.
		await waitFor(() => expect(openTabIds()).toEqual(["t2"]));
	});

	it("says which closes cannot act rather than offering an inert item", async () => {
		useTabsStore.setState({ openTabs: [TABS[0]], activeTabId: "t1" });
		renderStrip();

		await openMenuOn("t1");

		// One tab open: nothing else to close, and nothing to its right.
		expect(screen.getByRole("menuitem", { name: "Close Others" })).toHaveAttribute(
			"data-disabled"
		);
		expect(screen.getByRole("menuitem", { name: "Close to the Right" })).toHaveAttribute(
			"data-disabled"
		);
	});

	it("offers Copy Path only where a tab has one", async () => {
		renderStrip();

		await openMenuOn("t3");

		// A singleton tab is not in a collection, so there is no path to copy.
		expect(screen.queryByRole("menuitem", { name: "Copy Path" })).toBeNull();
	});

	it("marks a tab so the main process draws no edit menu over it", () => {
		renderStrip();

		expect(tab("t1")).toHaveAttribute(CONTEXT_ATTRIBUTE, "own-menu");
	});
});
