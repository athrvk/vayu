// UI State Types

import type {
	Request,
	Collection,
	Environment,
	Run,
	LoadTestMetrics,
	RunReport,
	SanityResult,
	LoadTestConfig,
} from "./domain";

// Sidebar Navigation
export type SidebarTab =
	| "collections"
	| "history"
	| "environments"
	| "settings";

// Main Screen Views
export type MainScreen =
	| "request-builder"
	| "dashboard"
	| "history-detail"
	| "welcome";

// Dashboard Mode
export type DashboardMode = "running" | "completed";

// App State
export interface AppState {
	activeSidebarTab: SidebarTab;
	activeScreen: MainScreen;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	selectedRunId: string | null;
	isEngineConnected: boolean;
	engineError: string | null;
}

// Request Builder State
export interface RequestBuilderState {
	currentRequest: Partial<Request> | null;
	isLoading: boolean;
	isSaving: boolean;
	hasUnsavedChanges: boolean;
	responseData: SanityResult | null;
	isExecuting: boolean;
	activeTab: "params" | "headers" | "body" | "pre-script" | "test-script";
}

// Collections State
export interface CollectionsState {
	collections: Collection[];
	requests: Record<string, Request[]>; // Keyed by collection_id
	isLoading: boolean;
	error: string | null;
	expandedCollectionIds: Set<string>;
}

// Dashboard State
export interface DashboardState {
	currentRunId: string | null;
	mode: DashboardMode;
	isStreaming: boolean;
	currentMetrics: LoadTestMetrics | null;
	historicalMetrics: LoadTestMetrics[];
	finalReport: RunReport | null;
	error: string | null;
	activeView: "metrics" | "request-response";
}

// History State
export interface HistoryState {
	runs: Run[];
	isLoading: boolean;
	error: string | null;
	searchQuery: string;
	filterType: "all" | "load" | "sanity";
	filterStatus: "all" | "running" | "completed" | "failed";
	sortBy: "newest" | "oldest";
	totalCount: number;
}

// Environment State
export interface EnvironmentState {
	environments: Environment[];
	activeEnvironmentId: string | null;
	isLoading: boolean;
	error: string | null;
	isEditing: boolean;
	editingEnvironmentId: string | null;
}

// Load Test Config Dialog State
export interface LoadTestDialogState {
	isOpen: boolean;
	requestId: string | null;
	environmentId: string | null;
	config: Partial<LoadTestConfig>;
	errors: Record<string, string>;
}

// Notification/Toast
export interface Notification {
	id: string;
	type: "success" | "error" | "warning" | "info";
	message: string;
	duration?: number;
}
