/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Four independent maps, one store, one `clearEntity`/`clearAll` pair.
 *
 * Mutation check: drop the `.set` line in any of `setRequestTab` /
 * `setResponseTab` / `setCollectionTab` / `setElementRowOpen` and its own
 * "gets back what it set" case fails; drop one map's `.delete` from
 * `clearEntity` and "drops all four" fails for that map alone, showing the
 * other three were never at risk; drop the early-return guard in
 * `clearEntity` and "an absent id changes nothing" fails, because every map
 * would get a new reference for a delete that changed no key.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useTabSelectionStore } from "./tab-selection-store";

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
});

describe("each map is independent", () => {
	it("gets back what it set, per map", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setResponseTab("r1", "timing");
		useTabSelectionStore.getState().setCollectionTab("c1", "elements");
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_1", true);

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBe("headers");
		expect(useTabSelectionStore.getState().getResponseTab("r1")).toBe("timing");
		expect(useTabSelectionStore.getState().getCollectionTab("c1")).toBe("elements");
		expect(useTabSelectionStore.getState().getOpenElementRows("r1")).toEqual(new Set(["el_1"]));
	});

	it("returns null for an id nothing has set", () => {
		expect(useTabSelectionStore.getState().getRequestTab("never-set")).toBeNull();
		expect(useTabSelectionStore.getState().getResponseTab("never-set")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("never-set")).toBeNull();
		expect(useTabSelectionStore.getState().getOpenElementRows("never-set")).toBeNull();
	});

	it("a write to one map never appears in the other two, even under the same id", () => {
		useTabSelectionStore.getState().setRequestTab("shared-id", "auth");

		expect(useTabSelectionStore.getState().getResponseTab("shared-id")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("shared-id")).toBeNull();
		expect(useTabSelectionStore.getState().getOpenElementRows("shared-id")).toBeNull();
	});

	it("a later set for the same id replaces the earlier one", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setRequestTab("r1", "body");

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBe("body");
	});
});

describe("open element rows", () => {
	it("round-trips per entity, and two entities never see each other's ids", () => {
		const { setElementRowOpen, getOpenElementRows } = useTabSelectionStore.getState();
		setElementRowOpen("r1", "el_a", true);
		setElementRowOpen("r1", "el_b", true);
		// The same element id under another entity is a different row.
		setElementRowOpen("r2", "el_a", true);
		setElementRowOpen("r2", "el_c", true);

		expect(getOpenElementRows("r1")).toEqual(new Set(["el_a", "el_b"]));
		expect(getOpenElementRows("r2")).toEqual(new Set(["el_a", "el_c"]));
	});

	it("closing a row removes just that id", () => {
		const { setElementRowOpen, getOpenElementRows } = useTabSelectionStore.getState();
		setElementRowOpen("r1", "el_a", true);
		setElementRowOpen("r1", "el_b", true);

		setElementRowOpen("r1", "el_a", false);

		expect(getOpenElementRows("r1")).toEqual(new Set(["el_b"]));
	});

	it("replaces the entity's set rather than mutating the one a subscriber holds", () => {
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_a", true);
		const held = useTabSelectionStore.getState().getOpenElementRows("r1");

		useTabSelectionStore.getState().setElementRowOpen("r1", "el_b", true);

		expect(held).toEqual(new Set(["el_a"]));
		expect(useTabSelectionStore.getState().getOpenElementRows("r1")).not.toBe(held);
	});

	it("a write that changes nothing hands subscribers no new reference", () => {
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_a", true);
		const before = useTabSelectionStore.getState().openElementRows;

		useTabSelectionStore.getState().setElementRowOpen("r1", "el_a", true);
		useTabSelectionStore.getState().setElementRowOpen("r1", "never-open", false);

		expect(useTabSelectionStore.getState().openElementRows).toBe(before);
	});
});

describe("clearEntity", () => {
	it("drops the id from all four maps", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setResponseTab("r1", "timing");
		useTabSelectionStore.getState().setCollectionTab("r1", "elements");
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_1", true);

		useTabSelectionStore.getState().clearEntity("r1");

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBeNull();
		expect(useTabSelectionStore.getState().getResponseTab("r1")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("r1")).toBeNull();
		expect(useTabSelectionStore.getState().getOpenElementRows("r1")).toBeNull();
		expect(useTabSelectionStore.getState().openElementRows.has("r1")).toBe(false);
	});

	it("drops an id that only has open element rows", () => {
		useTabSelectionStore.getState().setElementRowOpen("c1", "el_1", true);

		useTabSelectionStore.getState().clearEntity("c1");

		expect(useTabSelectionStore.getState().openElementRows.has("c1")).toBe(false);
	});

	it("leaves every other id untouched", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setRequestTab("r2", "auth");
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_1", true);
		useTabSelectionStore.getState().setElementRowOpen("r2", "el_2", true);

		useTabSelectionStore.getState().clearEntity("r1");

		expect(useTabSelectionStore.getState().getRequestTab("r2")).toBe("auth");
		expect(useTabSelectionStore.getState().getOpenElementRows("r2")).toEqual(new Set(["el_2"]));
	});

	it("an absent id changes nothing", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_1", true);
		const before = useTabSelectionStore.getState();

		useTabSelectionStore.getState().clearEntity("never-set");

		const after = useTabSelectionStore.getState();
		// The same map references, not merely equal ones - a delete that hit
		// nothing must not hand every subscriber a reason to re-render.
		expect(after.requestTab).toBe(before.requestTab);
		expect(after.responseTab).toBe(before.responseTab);
		expect(after.collectionTab).toBe(before.collectionTab);
		expect(after.openElementRows).toBe(before.openElementRows);
	});
});

describe("clearAll", () => {
	it("empties all four maps", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setResponseTab("r1", "timing");
		useTabSelectionStore.getState().setCollectionTab("c1", "elements");
		useTabSelectionStore.getState().setElementRowOpen("r1", "el_1", true);

		useTabSelectionStore.getState().clearAll();

		expect(useTabSelectionStore.getState().requestTab.size).toBe(0);
		expect(useTabSelectionStore.getState().responseTab.size).toBe(0);
		expect(useTabSelectionStore.getState().collectionTab.size).toBe(0);
		expect(useTabSelectionStore.getState().openElementRows.size).toBe(0);
	});
});
