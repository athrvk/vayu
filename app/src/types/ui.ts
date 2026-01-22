
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// UI State Types
// Only types that are actually imported by components are kept here.
// Stores define their own state interfaces inline.

// Sidebar Navigation
export type SidebarTab = "collections" | "history" | "variables" | "settings";

// Main Screen Views
export type MainScreen =
	| "request-builder"
	| "dashboard"
	| "history"
	| "variables"
	| "settings"
	| "welcome";
