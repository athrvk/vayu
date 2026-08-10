/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The explorer's view state. What the pane does with it is pinned in
 * `SchemaExplorer.test.tsx`; this covers the part no rendered pane reaches -
 * the cap that stops a long session accumulating a view per endpoint it ever
 * pointed at.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EXPLORER_VIEW_MAX_ENTRIES, useExplorerStore } from "./explorer-store";

const store = () => useExplorerStore.getState();

beforeEach(() => useExplorerStore.setState({ open: false, byKey: {}, lru: [] }));

describe("per-schema view state", () => {
	it("starts every schema at an empty view rather than undefined", () => {
		expect(store().view("never-seen")).toEqual({ search: "", expanded: [], scrollTop: 0 });
	});

	it("toggles an id on and off", () => {
		store().toggleExpanded("k", "branch:query");
		expect(store().view("k").expanded).toEqual(["branch:query"]);
		store().toggleExpanded("k", "branch:query");
		expect(store().view("k").expanded).toEqual([]);
	});

	it("keeps search, expansion and scroll independent of each other", () => {
		store().setSearch("k", "post");
		store().toggleExpanded("k", "branch:types");
		store().setScrollTop("k", 42);
		expect(store().view("k")).toEqual({
			search: "post",
			expanded: ["branch:types"],
			scrollTop: 42,
		});
	});
});

describe("the cap", () => {
	it("drops the least recently touched schema once it is full", () => {
		for (let i = 0; i < EXPLORER_VIEW_MAX_ENTRIES; i++) store().setSearch(`k${i}`, `s${i}`);
		// Touch the oldest, so it is no longer the one at risk.
		store().setSearch("k0", "still here");
		store().setSearch("overflow", "new");

		expect(store().view("k0").search).toBe("still here");
		expect(store().view("k1").search).toBe("");
		expect(Object.keys(store().byKey)).toHaveLength(EXPLORER_VIEW_MAX_ENTRIES);
	});
});
