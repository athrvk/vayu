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
 * - Last collection worked in (new-request target)
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

interface SessionState {
	/**
	 * The environment every send resolves against. Cleared when that
	 * environment is deleted and when a rehydrated id names an environment the
	 * engine no longer has (`useActiveEnvironmentGuard`) - a stale id here does
	 * not just mislead the switcher, it rides on every `/compose` payload.
	 */
	activeEnvironmentId: string | null;
	/**
	 * The collection the user most recently worked in - updated when a request
	 * or collection tab becomes the source of truth (RequestBuilder /
	 * CollectionDetail). Used by the welcome screen to land a new request where
	 * the user was working. This is only a new-request target and must never
	 * feed the resolver: the resolver takes its scope from an explicit
	 * `collectionId`, so a collection the user has left cannot silently scope a
	 * `{{var}}` preview.
	 */
	lastCollectionId: string | null;

	setActiveEnvironmentId: (id: string | null) => void;
	setLastCollectionId: (id: string | null) => void;
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
			/**
			 * v1 -> v2 drops `activeCollectionId`. It had a reader (the resolver's
			 * fallback scope) and never had a writer, so an id stored by a much
			 * older build would rehydrate forever and scope preview resolution to a
			 * collection the user left - or deleted - versions ago. Dropping the key
			 * here rather than ignoring it keeps it from coming back if the field
			 * name is ever reused.
			 */
			migrate: (persisted, version) => {
				const state = (persisted ?? {}) as Partial<SessionState> & {
					activeCollectionId?: string | null;
				};
				if (version < 2) {
					delete state.activeCollectionId;
				}
				return state as SessionState;
			},
		}
	)
);
