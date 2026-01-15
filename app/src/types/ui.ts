// UI State Types
// Only types that are actually imported by components are kept here.
// Stores define their own state interfaces inline.

// Sidebar Navigation
export type SidebarTab =
	| "collections"
	| "history"
	| "variables"
	| "settings";

// Main Screen Views
export type MainScreen =
	| "request-builder"
	| "dashboard"
	| "history"
	| "history-detail"
	| "variables"
	| "welcome";
