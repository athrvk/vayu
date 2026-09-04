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
 * The palette and the Dock offer the same six views, so they name and mark them
 * the same way (#1341).
 *
 * Every assertion here is driven from `DRAWER_VIEWS` itself rather than from a
 * list of expected titles and icons: a test that restated the literals would
 * agree with a palette that had drifted, which is exactly how Collections came
 * to be `FolderOpen` in the Dock and `Folder` here. Mutation check: give the
 * mapped entry an icon of its own and the icon case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

import { DRAWER_VIEWS } from "@/constants/drawer-views";
import type { PaletteItem } from "../types";

const { revealDrawerView, activateDrawerView, openTab } = vi.hoisted(() => ({
	revealDrawerView: vi.fn(),
	activateDrawerView: vi.fn(),
	openTab: vi.fn(),
}));

vi.mock("@/stores", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useLayoutStore: (selector: (s: Record<string, unknown>) => unknown) =>
			selector({ revealDrawerView, activateDrawerView }),
		useTabsStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ openTab }),
	};
});

const { useViewItems } = await import("./useViewItems");

function items(): PaletteItem[] {
	return renderHook(() => useViewItems()).result.current;
}

function itemFor(title: string): PaletteItem {
	const found = items().find((item) => item.title === title);
	if (!found) throw new Error(`the palette offers no "${title}" row`);
	return found;
}

beforeEach(() => {
	revealDrawerView.mockClear();
	activateDrawerView.mockClear();
	openTab.mockClear();
});

describe("the six drawer views", () => {
	it("are offered in the Dock's order, under the Dock's names", () => {
		expect(
			items()
				.slice(0, DRAWER_VIEWS.length)
				.map((item) => item.title)
		).toEqual(DRAWER_VIEWS.map((view) => view.label));
	});

	it("carry the Dock's mark - the same icon component, not one that looks like it", () => {
		const offered = items();
		for (const [index, view] of DRAWER_VIEWS.entries()) {
			expect(offered[index].icon).toBe(view.icon);
		}
	});

	it("each have search synonyms of their own", () => {
		// The compile-time half of this is `Record<DrawerView, string[]>` in the
		// source: a seventh view added to `DRAWER_VIEWS` without a keywords line
		// fails `pnpm type-check`. What runs here is that none of the six was
		// given an empty list to satisfy the type.
		for (const [index] of DRAWER_VIEWS.entries()) {
			expect(items()[index].keywords?.length).toBeGreaterThan(0);
		}
	});
});

describe("what a view row does", () => {
	it("reveals the drawer view rather than toggling it", () => {
		itemFor("History").perform();

		expect(revealDrawerView).toHaveBeenCalledWith("history");
		expect(activateDrawerView).not.toHaveBeenCalled();
		expect(openTab).not.toHaveBeenCalled();
	});

	it("opens the tab as well for the two views that are also a tab", () => {
		itemFor("Variables").perform();

		expect(revealDrawerView).toHaveBeenCalledWith("variables");
		expect(openTab).toHaveBeenCalledWith({ type: "variables", entityId: null });

		openTab.mockClear();
		revealDrawerView.mockClear();

		itemFor("Settings").perform();

		expect(revealDrawerView).toHaveBeenCalledWith("settings");
		expect(openTab).toHaveBeenCalledWith({ type: "settings", entityId: null });
	});
});

describe("Inbox", () => {
	it("is still offered, after the six, as a tab with no drawer view", () => {
		const offered = items();

		expect(offered).toHaveLength(DRAWER_VIEWS.length + 1);
		expect(offered[offered.length - 1].title).toBe("Inbox");

		offered[offered.length - 1].perform();

		expect(openTab).toHaveBeenCalledWith({ type: "inbox", entityId: null });
		expect(revealDrawerView).not.toHaveBeenCalled();
	});
});
