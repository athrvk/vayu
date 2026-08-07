/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tree's expansion store - untested until now, which is how it came to hold
 * three actions with no callers at all while the tree hand-rolled two of them.
 *
 * No jsdom pragma: this store is a plain `create` with no `persist`, so nothing
 * here reaches `localStorage`.
 *
 * The identity assertions are the load-bearing ones. `expandedCollectionIds` is
 * a `Set` passed down the whole tree and listed in effect dependencies, so an
 * action that returns a fresh Set for a no-op re-renders every row and re-runs
 * the reveal effect - which is the exact shape of the bug that once pinned a
 * collection open.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useCollectionsStore } from "./collections-store";

const ids = () => [...useCollectionsStore.getState().expandedCollectionIds];
const set = () => useCollectionsStore.getState().expandedCollectionIds;

beforeEach(() => {
	useCollectionsStore.setState({ expandedCollectionIds: new Set<string>() });
});

describe("toggleCollectionExpanded", () => {
	it("expands then collapses the same id", () => {
		const { toggleCollectionExpanded } = useCollectionsStore.getState();

		toggleCollectionExpanded("c1");
		expect(ids()).toEqual(["c1"]);

		toggleCollectionExpanded("c1");
		expect(ids()).toEqual([]);
	});

	it("leaves other ids alone", () => {
		const { toggleCollectionExpanded } = useCollectionsStore.getState();

		toggleCollectionExpanded("c1");
		toggleCollectionExpanded("c2");
		toggleCollectionExpanded("c1");

		expect(ids()).toEqual(["c2"]);
	});
});

describe("expandCollection", () => {
	it("expands an id that was collapsed", () => {
		useCollectionsStore.getState().expandCollection("c1");

		expect(ids()).toEqual(["c1"]);
	});

	it("is a no-op on an already expanded id, down to the Set's identity", () => {
		const { expandCollection } = useCollectionsStore.getState();
		expandCollection("c1");
		const before = set();

		expandCollection("c1");

		// Not just equal contents: the same object, so every consumer that
		// compares by reference skips the re-render.
		expect(set()).toBe(before);
	});

	it("never toggles - the caller that wanted expand only cannot get a collapse", () => {
		const { expandCollection } = useCollectionsStore.getState();

		expandCollection("c1");
		expandCollection("c1");

		expect(ids()).toEqual(["c1"]);
	});
});

describe("expandCollections", () => {
	it("adds a whole ancestor chain at once, keeping what was already open", () => {
		const { expandCollection, expandCollections } = useCollectionsStore.getState();
		expandCollection("other");

		expandCollections(["root", "mid", "leaf"]);

		expect(ids().sort()).toEqual(["leaf", "mid", "other", "root"]);
	});

	it("keeps the same Set when every id is already expanded", () => {
		const { expandCollections } = useCollectionsStore.getState();
		expandCollections(["root", "mid"]);
		const before = set();

		expandCollections(["root", "mid"]);

		expect(set()).toBe(before);
	});

	it("replaces the Set when even one id is new", () => {
		const { expandCollections } = useCollectionsStore.getState();
		expandCollections(["root"]);
		const before = set();

		expandCollections(["root", "mid"]);

		expect(set()).not.toBe(before);
		expect(ids().sort()).toEqual(["mid", "root"]);
	});

	it("does nothing at all for an empty chain", () => {
		const before = set();

		useCollectionsStore.getState().expandCollections([]);

		expect(set()).toBe(before);
	});
});

describe("the store's surface", () => {
	it("exposes no action nothing calls", () => {
		// `collapseCollection` and `reset` sat here with zero callers app-wide -
		// collapsing goes through `toggleCollectionExpanded`, and nothing has ever
		// wanted to clear the whole set. A new action belongs here when its caller
		// does.
		expect(Object.keys(useCollectionsStore.getState()).sort()).toEqual([
			"expandCollection",
			"expandCollections",
			"expandedCollectionIds",
			"toggleCollectionExpanded",
		]);
	});
});
