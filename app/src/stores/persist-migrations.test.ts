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
 * A version bump must not be how a user loses their workspace.
 *
 * zustand compares a persisted payload's stamped version against the store's
 * and, when they differ and no `migrate` is supplied, throws the payload away -
 * it logs to the console and hands the store its defaults. `tabs-store` and
 * `session-store` were `version: 1` with no migrate, so the next bump would
 * have closed everyone's tabs and forgotten their active environment, quietly,
 * as a side effect of an unrelated change.
 *
 * These cases rehearse that bump end to end - through `persist.rehydrate()`,
 * not by calling `migrate` directly - so they cover the seam rather than the
 * function. (`session-store.test.ts` covers the v1 -> v2 field drop itself;
 * what is here is that a stamped payload survives the trip at all, and that a
 * malformed one degrades to defaults instead of reaching a reader.)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabsStore } from "./tabs-store";
import { useSessionStore } from "./session-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";

const seed = (key: string, payload: unknown) => localStorage.setItem(key, JSON.stringify(payload));

beforeEach(() => {
	localStorage.clear();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ activeEnvironmentId: null, lastCollectionId: null });
});

describe("tabs-store rehydration", () => {
	it("carries tabs across a version bump instead of dropping them", async () => {
		seed(STORAGE_KEYS.TABS_STORE, {
			version: 0,
			state: {
				openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
				activeTabId: "t1",
			},
		});

		await useTabsStore.persist.rehydrate();

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.map((t) => t.entityId)).toEqual(["r1"]);
		expect(activeTabId).toBe("t1");
	});

	it("falls back to an empty workspace on a payload of the wrong shape", async () => {
		// A hand-edited or half-written localStorage entry must not put a
		// non-array where every reader iterates.
		seed(STORAGE_KEYS.TABS_STORE, { version: 0, state: { openTabs: "nope", activeTabId: 7 } });

		await useTabsStore.persist.rehydrate();

		expect(useTabsStore.getState().openTabs).toEqual([]);
		expect(useTabsStore.getState().activeTabId).toBeNull();
	});
});

describe("session-store rehydration", () => {
	it("carries the active ids across a version bump", async () => {
		seed(STORAGE_KEYS.SESSION_STORE, {
			version: 1,
			state: {
				activeEnvironmentId: "env_1",
				activeCollectionId: "col_1", // dropped by the v1 -> v2 migration
				lastCollectionId: "col_2",
			},
		});

		await useSessionStore.persist.rehydrate();

		const s = useSessionStore.getState();
		expect(s.activeEnvironmentId).toBe("env_1");
		expect(s.lastCollectionId).toBe("col_2");
		expect(s).not.toHaveProperty("activeCollectionId");
	});

	it("refuses a non-string id rather than handing one to the resolver", async () => {
		// A non-string `activeEnvironmentId` does not just mislead the switcher:
		// it rides on every `/compose` payload.
		seed(STORAGE_KEYS.SESSION_STORE, {
			version: 1,
			state: { activeEnvironmentId: 42, lastCollectionId: {} },
		});

		await useSessionStore.persist.rehydrate();

		const s = useSessionStore.getState();
		expect(s.activeEnvironmentId).toBeNull();
		expect(s.lastCollectionId).toBeNull();
	});
});
