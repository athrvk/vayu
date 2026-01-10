// Environment State Store

import { create } from "zustand";
import type { Environment } from "@/types";

interface EnvironmentState {
	environments: Environment[];
	activeEnvironmentId: string | null;
	isLoading: boolean;
	error: string | null;
	isEditing: boolean;
	editingEnvironmentId: string | null;

	// Actions
	setEnvironments: (environments: Environment[]) => void;
	addEnvironment: (environment: Environment) => void;
	updateEnvironment: (environment: Environment) => void;
	removeEnvironment: (environmentId: string) => void;
	setActiveEnvironment: (environmentId: string | null) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	startEditing: (environmentId: string) => void;
	stopEditing: () => void;

	// Helpers
	getActiveEnvironment: () => Environment | undefined;
	getEnvironmentById: (environmentId: string) => Environment | undefined;
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
	environments: [],
	activeEnvironmentId: null,
	isLoading: false,
	error: null,
	isEditing: false,
	editingEnvironmentId: null,

	setEnvironments: (environments) => {
		const activeEnv = environments.find((e) => e.is_active);
		set({
			environments,
			activeEnvironmentId: activeEnv?.id || null,
		});
	},

	addEnvironment: (environment) =>
		set((state) => ({
			environments: [...state.environments, environment],
			activeEnvironmentId: environment.is_active
				? environment.id
				: state.activeEnvironmentId,
		})),

	updateEnvironment: (environment) =>
		set((state) => ({
			environments: state.environments.map((e) =>
				e.id === environment.id ? environment : e
			),
			activeEnvironmentId: environment.is_active
				? environment.id
				: state.activeEnvironmentId,
		})),

	removeEnvironment: (environmentId) =>
		set((state) => ({
			environments: state.environments.filter((e) => e.id !== environmentId),
			activeEnvironmentId:
				state.activeEnvironmentId === environmentId
					? null
					: state.activeEnvironmentId,
		})),

	setActiveEnvironment: (environmentId) =>
		set({ activeEnvironmentId: environmentId }),
	setLoading: (loading) => set({ isLoading: loading }),
	setError: (error) => set({ error }),
	startEditing: (environmentId) =>
		set({ isEditing: true, editingEnvironmentId: environmentId }),
	stopEditing: () => set({ isEditing: false, editingEnvironmentId: null }),

	// Helpers
	getActiveEnvironment: () => {
		const { activeEnvironmentId, environments } = get();
		return environments.find((e) => e.id === activeEnvironmentId);
	},

	getEnvironmentById: (environmentId) => {
		return get().environments.find((e) => e.id === environmentId);
	},
}));
