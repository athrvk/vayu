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
		}
	)
);
