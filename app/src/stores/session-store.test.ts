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
 * `activeCollectionId` is gone, and a persisted one must not come back.
 *
 * The field had a reader - the resolver's fallback scope for option-less
 * callers - and no writer anywhere, so on a fresh install it was permanently
 * null, and on an install old enough to have stored one it rehydrated every
 * launch and scoped `{{var}}` previews to a collection the user had left or
 * deleted. Removing the reader is not enough on its own: the stored key
 * survives in localStorage, so the migration has to drop it, or a future field
 * reusing the name would inherit a value from an unrelated build.
 *
 * `lastCollectionId` is the field that looks similar and is not: it has a real
 * writer and feeds the welcome screen, never the resolver.
 */

import { describe, it, expect } from "vitest";
import { useSessionStore } from "./session-store";

/** The persist option the store was built with, reached the way zustand does. */
const persistOptions = useSessionStore.persist.getOptions();

describe("session-store persistence", () => {
	it("drops a v1 activeCollectionId on migration", () => {
		const migrated = persistOptions.migrate?.(
			{ activeEnvironmentId: "e1", activeCollectionId: "c1", lastCollectionId: "c9" },
			1
		) as Record<string, unknown>;

		expect(migrated).not.toHaveProperty("activeCollectionId");
		// The two fields that survive it, so the migration is a drop and not a wipe.
		expect(migrated.activeEnvironmentId).toBe("e1");
		expect(migrated.lastCollectionId).toBe("c9");
	});

	it("tolerates a v1 payload that never had the key", () => {
		const migrated = persistOptions.migrate?.({ activeEnvironmentId: null }, 1) as Record<
			string,
			unknown
		>;
		expect(migrated).not.toHaveProperty("activeCollectionId");
	});

	it("is at version 2, so the migration actually runs for stored v1 state", () => {
		// zustand only calls `migrate` when the stored version is below this one.
		expect(persistOptions.version).toBe(2);
	});

	it("persists only the environment id and the new-request target", () => {
		const persisted = persistOptions.partialize?.({
			activeEnvironmentId: "e1",
			lastCollectionId: "c9",
			setActiveEnvironmentId: () => {},
			setLastCollectionId: () => {},
		} as Parameters<NonNullable<typeof persistOptions.partialize>>[0]);

		expect(Object.keys(persisted as object).sort()).toEqual([
			"activeEnvironmentId",
			"lastCollectionId",
		]);
	});
});
