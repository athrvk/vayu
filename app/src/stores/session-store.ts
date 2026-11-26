/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Persisted session state: the active environment (for variable resolution) and the last collection
 * worked in (the new-request target).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

interface SessionState {
	/**
	 * The environment every send resolves against. Cleared when that environment is deleted and
	 * when a rehydrated id names one the engine no longer has (`useActiveEnvironmentGuard`): a
	 * stale id here does not just mislead the switcher, it rides on every `/compose` payload.
	 */
	activeEnvironmentId: string | null;
	/**
	 * The collection the user most recently worked in, updated when a request or collection tab
	 * becomes the source of truth (RequestBuilder / CollectionDetail); the welcome screen lands a
	 * new request there. Only a new-request target, never fed to the resolver: it takes its scope
	 * from an explicit `collectionId`, so a collection the user has left cannot silently scope a
	 * `{{var}}` preview.
	 */
	lastCollectionId: string | null;

	setActiveEnvironmentId: (id: string | null) => void;
	setLastCollectionId: (id: string | null) => void;
}

/** The slice of the store that reaches localStorage - see `partialize` below. */
interface PersistedSession {
	activeEnvironmentId: string | null;
	lastCollectionId: string | null;
}

const asId = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Version translation for the persisted session ids. v1 -> v2 drops `activeCollectionId`: it had a
 * reader (the resolver's fallback scope) and never a writer, so an id stored by a much older build
 * would rehydrate forever and scope preview resolution to a collection the user left, or deleted,
 * versions ago.
 *
 * Rebuilt from the fields v2 knows rather than deleting that one key: a whitelist drops anything an
 * older build stored, including a future field that reuses the name, and it is where the next bump
 * goes too. zustand discards a payload whose stamped version does not match when no `migrate` is
 * supplied, so a bump without one silently forgets the user's active environment.
 *
 * Normalizing on the way through is the same job: a hand-edited or half-written entry must not hand
 * a non-string id to the switcher, and from there to every `/compose` payload.
 */
function migrateSession(persisted: unknown): PersistedSession {
	const stored = (persisted ?? {}) as Partial<PersistedSession>;
	return {
		activeEnvironmentId: asId(stored.activeEnvironmentId),
		lastCollectionId: asId(stored.lastCollectionId),
	};
}

export const useSessionStore = create<SessionState>()(
	persist(
		(set) => ({
			activeEnvironmentId: null,
			lastCollectionId: null,
			setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
			setLastCollectionId: (id) => set({ lastCollectionId: id }),
		}),
		{
			name: STORAGE_KEYS.SESSION_STORE,
			version: 2,
			partialize: (state) => ({
				activeEnvironmentId: state.activeEnvironmentId,
				lastCollectionId: state.lastCollectionId,
			}),
			migrate: migrateSession,
		}
	)
);
