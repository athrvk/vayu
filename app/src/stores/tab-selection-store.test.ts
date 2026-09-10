/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Three independent maps, one store, one `clearEntity`/`clearAll` pair.
 *
 * Mutation check: drop the `.set` line in any of `setRequestTab` /
 * `setResponseTab` / `setCollectionTab` and its own "gets back what it set"
 * case fails; drop one map's `.delete` from `clearEntity` and "drops all
 * three" fails for that map alone, showing the other two were never at risk;
 * drop the early-return guard in `clearEntity` and "an absent id changes
 * nothing" fails, because every map would get a new reference for a delete
 * that changed no key.
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

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBe("headers");
		expect(useTabSelectionStore.getState().getResponseTab("r1")).toBe("timing");
		expect(useTabSelectionStore.getState().getCollectionTab("c1")).toBe("elements");
	});

	it("returns null for an id nothing has set", () => {
		expect(useTabSelectionStore.getState().getRequestTab("never-set")).toBeNull();
		expect(useTabSelectionStore.getState().getResponseTab("never-set")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("never-set")).toBeNull();
	});

	it("a write to one map never appears in the other two, even under the same id", () => {
		useTabSelectionStore.getState().setRequestTab("shared-id", "auth");

		expect(useTabSelectionStore.getState().getResponseTab("shared-id")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("shared-id")).toBeNull();
	});

	it("a later set for the same id replaces the earlier one", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setRequestTab("r1", "body");

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBe("body");
	});
});

describe("clearEntity", () => {
	it("drops the id from all three maps", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setResponseTab("r1", "timing");
		useTabSelectionStore.getState().setCollectionTab("r1", "elements");

		useTabSelectionStore.getState().clearEntity("r1");

		expect(useTabSelectionStore.getState().getRequestTab("r1")).toBeNull();
		expect(useTabSelectionStore.getState().getResponseTab("r1")).toBeNull();
		expect(useTabSelectionStore.getState().getCollectionTab("r1")).toBeNull();
	});

	it("leaves every other id untouched", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setRequestTab("r2", "auth");

		useTabSelectionStore.getState().clearEntity("r1");

		expect(useTabSelectionStore.getState().getRequestTab("r2")).toBe("auth");
	});

	it("an absent id changes nothing", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		const before = useTabSelectionStore.getState();

		useTabSelectionStore.getState().clearEntity("never-set");

		const after = useTabSelectionStore.getState();
		// The same map references, not merely equal ones - a delete that hit
		// nothing must not hand every subscriber a reason to re-render.
		expect(after.requestTab).toBe(before.requestTab);
		expect(after.responseTab).toBe(before.responseTab);
		expect(after.collectionTab).toBe(before.collectionTab);
	});
});

describe("clearAll", () => {
	it("empties all three maps", () => {
		useTabSelectionStore.getState().setRequestTab("r1", "headers");
		useTabSelectionStore.getState().setResponseTab("r1", "timing");
		useTabSelectionStore.getState().setCollectionTab("c1", "elements");

		useTabSelectionStore.getState().clearAll();

		expect(useTabSelectionStore.getState().requestTab.size).toBe(0);
		expect(useTabSelectionStore.getState().responseTab.size).toBe(0);
		expect(useTabSelectionStore.getState().collectionTab.size).toBe(0);
	});
});
