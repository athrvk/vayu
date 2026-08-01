/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Session State Store
 *
 * Manages persistent application session state:
 * - Active environment (for variable resolution)
 * - Active collection context (for collection variables)
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

interface SessionState {
	activeEnvironmentId: string | null;
	activeCollectionId: string | null;
	/**
	 * The collection the user most recently worked in - updated when a request
	 * or collection tab becomes the source of truth (RequestBuilder /
	 * CollectionDetail). Used by the welcome screen to land a new request where
	 * the user was working. Deliberately distinct from `activeCollectionId`,
	 * which scopes variable resolution; this is only a new-request target and
	 * must not feed the resolver.
	 */
	lastCollectionId: string | null;

	setActiveEnvironmentId: (id: string | null) => void;
	setActiveCollectionId: (id: string | null) => void;
	setLastCollectionId: (id: string | null) => void;
}

/** The slice of the store that reaches localStorage - see `partialize` below. */
interface PersistedSession {
	activeEnvironmentId: string | null;
	activeCollectionId: string | null;
	lastCollectionId: string | null;
}

const asId = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Version translation for the persisted session ids.
 *
 * zustand *discards* a payload whose stamped version does not match `version`
 * unless a `migrate` is supplied - it logs to the console and hands the store
 * its defaults - so a future bump without this would silently drop the user's
 * active environment and collection. This is where that bump goes: add a branch
 * per old version. Until then there is one shape, and the only work is refusing
 * a payload that is not it.
 */
function migrateSession(persisted: unknown): PersistedSession {
	const stored = (persisted ?? {}) as Partial<PersistedSession>;
	return {
		activeEnvironmentId: asId(stored.activeEnvironmentId),
		activeCollectionId: asId(stored.activeCollectionId),
		lastCollectionId: asId(stored.lastCollectionId),
	};
}

export const useSessionStore = create<SessionState>()(
	persist(
		(set) => ({
			activeEnvironmentId: null,
			activeCollectionId: null,
			lastCollectionId: null,
			setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
			setActiveCollectionId: (id) => set({ activeCollectionId: id }),
			setLastCollectionId: (id) => set({ lastCollectionId: id }),
		}),
		{
			name: STORAGE_KEYS.SESSION_STORE,
			version: 1,
			partialize: (state) => ({
				activeEnvironmentId: state.activeEnvironmentId,
				activeCollectionId: state.activeCollectionId,
				lastCollectionId: state.lastCollectionId,
			}),
			migrate: migrateSession,
		}
	)
);
