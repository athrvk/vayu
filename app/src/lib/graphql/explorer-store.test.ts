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
		expect(store().view("never-seen")).toEqual({
			search: "",
			expanded: [],
			scrollTop: 0,
			showDescriptions: false,
		});
	});

	it("toggles an id on and off", () => {
		store().toggleExpanded("k", "branch:query");
		expect(store().view("k").expanded).toEqual(["branch:query"]);
		store().toggleExpanded("k", "branch:query");
		expect(store().view("k").expanded).toEqual([]);
	});

	it("opens a whole path at once and spends the search that led there", () => {
		store().setSearch("k", "handle");
		store().revealPath("k", ["branch:types", "branch:types/type:User"]);

		expect(store().view("k").expanded).toEqual(["branch:types", "branch:types/type:User"]);
		// The result list is what the user is leaving; keeping the term would
		// redraw it over the tree they asked to see.
		expect(store().view("k").search).toBe("");
	});

	it("adds to a path rather than toggling it, so an open row stays open", () => {
		store().toggleExpanded("k", "branch:types");
		store().revealPath("k", ["branch:types", "branch:types/type:User"]);

		// A toggle would have closed Types on the way down to User.
		expect(store().view("k").expanded).toEqual(["branch:types", "branch:types/type:User"]);
	});

	it("keeps search, expansion, scroll and descriptions independent of each other", () => {
		store().setSearch("k", "post");
		store().toggleExpanded("k", "branch:types");
		store().setScrollTop("k", 42);
		store().toggleDescriptions("k");
		expect(store().view("k")).toEqual({
			search: "post",
			expanded: ["branch:types"],
			scrollTop: 42,
			showDescriptions: true,
		});
	});

	it("toggles descriptions off again, and keeps two schemas' answers apart", () => {
		store().toggleDescriptions("k");
		store().toggleDescriptions("k");
		expect(store().view("k").showDescriptions).toBe(false);

		store().toggleDescriptions("other");
		expect(store().view("other").showDescriptions).toBe(true);
		expect(store().view("k").showDescriptions).toBe(false);
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
