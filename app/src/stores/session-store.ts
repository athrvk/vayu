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

interface SessionState {
	activeEnvironmentId: string | null;
	activeCollectionId: string | null;

	setActiveEnvironmentId: (id: string | null) => void;
	setActiveCollectionId: (id: string | null) => void;
}

export const useSessionStore = create<SessionState>()(
	persist(
		(set) => ({
			activeEnvironmentId: null,
			activeCollectionId: null,
			setActiveEnvironmentId: (id) => set({ activeEnvironmentId: id }),
			setActiveCollectionId: (id) => set({ activeCollectionId: id }),
		}),
		{
			name: "vayu.session",
			version: 1,
			partialize: (state) => ({
				activeEnvironmentId: state.activeEnvironmentId,
				activeCollectionId: state.activeCollectionId,
			}),
		}
	)
);
