// Navigation State Store
// Handles all navigation-related state: tabs, screens, selections, and tab memory

import { create } from "zustand";
import type { SidebarTab, MainScreen } from "@/types";

export interface NavigationContext {
	screen: MainScreen;
	collectionId: string | null;
	requestId: string | null;
	runId: string | null;
}

interface NavigationState {
	// Current navigation state
	activeSidebarTab: SidebarTab;
	activeScreen: MainScreen;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	selectedRunId: string | null;

	// Navigation history - for back navigation
	previousContext: NavigationContext | null;

	// Tab memory - remember last screen/selection for each tab
	tabMemory: Record<SidebarTab, NavigationContext>;

	// Actions
	setActiveSidebarTab: (tab: SidebarTab) => void;
	setActiveScreen: (screen: MainScreen) => void;
	setSelectedCollectionId: (id: string | null) => void;
	setSelectedRequestId: (id: string | null) => void;
	setSelectedRunId: (id: string | null) => void;

	// Navigation helpers
	navigateToRequest: (collectionId: string, requestId: string) => void;
	navigateToRunDetail: (runId: string) => void;
	navigateToHistory: () => void;
	navigateToVariables: () => void;
	navigateToWelcome: () => void;
	navigateToDashboard: () => void;
	navigateBack: () => void;
	canNavigateBack: () => boolean;
}

// Default tab memory
const defaultTabMemory: Record<SidebarTab, NavigationContext> = {
	collections: { screen: "welcome", collectionId: null, requestId: null, runId: null },
	history: { screen: "history", collectionId: null, requestId: null, runId: null },
	variables: { screen: "variables", collectionId: null, requestId: null, runId: null },
	settings: { screen: "welcome", collectionId: null, requestId: null, runId: null },
};

export const useNavigationStore = create<NavigationState>((set, get) => ({
	// Initial state
	activeSidebarTab: "collections",
	activeScreen: "welcome",
	selectedCollectionId: null,
	selectedRequestId: null,
	selectedRunId: null,
	previousContext: null,
	tabMemory: { ...defaultTabMemory },

	// Actions
	setActiveSidebarTab: (tab) => {
		const state = get();

		// Save current context to tab memory before switching
		const currentTab = state.activeSidebarTab;
		const currentContext: NavigationContext = {
			screen: state.activeScreen,
			collectionId: state.selectedCollectionId,
			requestId: state.selectedRequestId,
			runId: state.selectedRunId,
		};

		// Restore context from the target tab's memory
		const targetContext = state.tabMemory[tab];

		set({
			activeSidebarTab: tab,
			activeScreen: targetContext.screen,
			selectedCollectionId: targetContext.collectionId,
			selectedRequestId: targetContext.requestId,
			selectedRunId: targetContext.runId,
			tabMemory: {
				...state.tabMemory,
				[currentTab]: currentContext,
			},
		});
	},

	setActiveScreen: (screen) => set({ activeScreen: screen }),
	setSelectedCollectionId: (id) => set({ selectedCollectionId: id }),
	setSelectedRequestId: (id) => set({ selectedRequestId: id }),
	setSelectedRunId: (id) => set({ selectedRunId: id }),

	// Navigation helpers
	navigateToRequest: (collectionId, requestId) => {
		const state = get();

		// Update tab memory for collections tab
		set({
			selectedCollectionId: collectionId,
			selectedRequestId: requestId,
			activeScreen: "request-builder",
			activeSidebarTab: "collections",
			tabMemory: {
				...state.tabMemory,
				collections: {
					screen: "request-builder",
					collectionId,
					requestId,
					runId: null,
				},
			},
		});
	},

	navigateToRunDetail: (runId) => {
		const state = get();

		set({
			selectedRunId: runId,
			activeScreen: "history-detail",
			activeSidebarTab: "history",
			tabMemory: {
				...state.tabMemory,
				history: {
					screen: "history-detail",
					collectionId: null,
					requestId: null,
					runId,
				},
			},
		});
	},

	navigateToHistory: () => {
		const state = get();

		set({
			activeScreen: "history",
			activeSidebarTab: "history",
			selectedRunId: null,
			tabMemory: {
				...state.tabMemory,
				history: {
					screen: "history",
					collectionId: null,
					requestId: null,
					runId: null,
				},
			},
		});
	},

	navigateToVariables: () => {
		const state = get();

		// Save current context before navigating
		const currentContext: NavigationContext = {
			screen: state.activeScreen,
			collectionId: state.selectedCollectionId,
			requestId: state.selectedRequestId,
			runId: state.selectedRunId,
		};

		set({
			activeScreen: "variables",
			activeSidebarTab: "variables",
			tabMemory: {
				...state.tabMemory,
				[state.activeSidebarTab]: currentContext,
				variables: {
					screen: "variables",
					collectionId: null,
					requestId: null,
					runId: null,
				},
			},
		});
	},

	navigateToWelcome: () =>
		set({
			activeScreen: "welcome",
			selectedCollectionId: null,
			selectedRequestId: null,
			selectedRunId: null,
		}),

	navigateToDashboard: () => {
		const state = get();

		// Save current context for back navigation
		const currentContext: NavigationContext = {
			screen: state.activeScreen,
			collectionId: state.selectedCollectionId,
			requestId: state.selectedRequestId,
			runId: state.selectedRunId,
		};

		set({
			activeScreen: "dashboard",
			previousContext: currentContext,
		});
	},

	navigateBack: () => {
		const state = get();
		const prev = state.previousContext;

		if (prev) {
			set({
				activeScreen: prev.screen,
				selectedCollectionId: prev.collectionId,
				selectedRequestId: prev.requestId,
				selectedRunId: prev.runId,
				previousContext: null,
			});
		}
	},

	canNavigateBack: () => {
		return get().previousContext !== null;
	},
}));
