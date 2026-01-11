// Environment UI State Store
// Server state (environments) is now managed by TanStack Query

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface EnvironmentUIState {
	// UI-only state
	activeEnvironmentId: string | null;
	isEditing: boolean;
	editingEnvironmentId: string | null;

	// Actions
	setActiveEnvironment: (environmentId: string | null) => void;
	startEditing: (environmentId: string) => void;
	stopEditing: () => void;
	reset: () => void;
}

export const useEnvironmentStore = create<EnvironmentUIState>()(
	persist(
		(set) => ({
			activeEnvironmentId: null,
			isEditing: false,
			editingEnvironmentId: null,

			setActiveEnvironment: (environmentId) =>
				set({ activeEnvironmentId: environmentId }),

			startEditing: (environmentId) =>
				set({ isEditing: true, editingEnvironmentId: environmentId }),

			stopEditing: () =>
				set({ isEditing: false, editingEnvironmentId: null }),

			reset: () =>
				set({
					activeEnvironmentId: null,
					isEditing: false,
					editingEnvironmentId: null,
				}),
		}),
		{
			name: "environment-ui-store",
			partialize: (state) => ({
				// Only persist the active environment selection
				activeEnvironmentId: state.activeEnvironmentId,
			}),
		}
	)
);
