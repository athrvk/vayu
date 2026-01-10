// Global App State Store

import { create } from "zustand";
import type { SidebarTab, MainScreen } from "@/types";

interface AppState {
	// Navigation
	activeSidebarTab: SidebarTab;
	activeScreen: MainScreen;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	selectedRunId: string | null;

	// Engine Connection
	isEngineConnected: boolean;
	engineError: string | null;

	// Actions
	setActiveSidebarTab: (tab: SidebarTab) => void;
	setActiveScreen: (screen: MainScreen) => void;
	setSelectedCollectionId: (id: string | null) => void;
	setSelectedRequestId: (id: string | null) => void;
	setSelectedRunId: (id: string | null) => void;
	setEngineConnected: (connected: boolean) => void;
	setEngineError: (error: string | null) => void;

	// Navigation helpers
	navigateToRequest: (collectionId: string, requestId: string) => void;
	navigateToRunDetail: (runId: string) => void;
	navigateToWelcome: () => void;
}

export const useAppStore = create<AppState>((set) => ({
	// Initial state
	activeSidebarTab: "collections",
	activeScreen: "welcome",
	selectedCollectionId: null,
	selectedRequestId: null,
	selectedRunId: null,
	isEngineConnected: false,
	engineError: null,

	// Actions
	setActiveSidebarTab: (tab) => set({ activeSidebarTab: tab }),
	setActiveScreen: (screen) => set({ activeScreen: screen }),
	setSelectedCollectionId: (id) => set({ selectedCollectionId: id }),
	setSelectedRequestId: (id) => set({ selectedRequestId: id }),
	setSelectedRunId: (id) => set({ selectedRunId: id }),
	setEngineConnected: (connected) => set({ isEngineConnected: connected }),
	setEngineError: (error) => set({ engineError: error }),

	// Navigation helpers
	navigateToRequest: (collectionId, requestId) =>
		set({
			selectedCollectionId: collectionId,
			selectedRequestId: requestId,
			activeScreen: "request-builder",
			activeSidebarTab: "collections",
		}),

	navigateToRunDetail: (runId) =>
		set({
			selectedRunId: runId,
			activeScreen: "history-detail",
			activeSidebarTab: "history",
		}),

	navigateToWelcome: () =>
		set({
			activeScreen: "welcome",
			selectedCollectionId: null,
			selectedRequestId: null,
			selectedRunId: null,
		}),
}));
