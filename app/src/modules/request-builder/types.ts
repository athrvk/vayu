
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilder Types
 *
 * Centralized type definitions for the request builder module.
 * KeyValueItem is the UI-layer extension of the domain KeyValueEntry,
 * adding an ephemeral `id` for stable React keys and a `system` flag.
 */

import type { HttpMethod, KeyValueEntry, ResolvedVariable, VariableScope } from "@/types";

// ============================================================================
// Key-Value Types (shared across params, headers, form-data)
// ============================================================================

/**
 * UI-layer extension of KeyValueEntry with a stable React key (`id`).
 * The `id` is ephemeral — it is NOT persisted to the backend.
 * Strip it with `toKeyValueEntries()` before sending to the API.
 */
export interface KeyValueItem extends KeyValueEntry {
	id: string;
	system?: boolean; // true = row is managed by the system (e.g. X-Request-ID)
}

// ============================================================================
// Tab Types
// ============================================================================

export type RequestTab = "params" | "headers" | "body" | "auth" | "pre-script" | "test-script";

export interface TabInfo {
	id: RequestTab;
	label: string;
	badge?: number;
}

// ============================================================================
// Auth Types
// ============================================================================

export type AuthType = "none" | "inherit" | "bearer" | "basic" | "api-key";

export interface AuthConfig {
	type: AuthType;
	bearer?: {
		token: string;
	};
	basic?: {
		username: string;
		password: string;
	};
	apiKey?: {
		key: string;
		value: string;
		addTo: "header" | "query";
	};
}

// ============================================================================
// Body Types
// ============================================================================

export type BodyMode = "none" | "json" | "text" | "form-data" | "x-www-form-urlencoded";

export interface BodyConfig {
	mode: BodyMode;
	raw?: string;
	formData?: KeyValueItem[];
	urlEncoded?: KeyValueItem[];
}

// ============================================================================
// Request State
// ============================================================================

export interface RequestState {
	// Identity
	id: string | null;
	collectionId: string | null;
	name: string;
	description?: string;

	// Request
	method: HttpMethod;
	url: string;
	params: KeyValueItem[];
	headers: KeyValueItem[];

	// Body (flattened for editor access)
	bodyMode: BodyMode;
	body: string; // Raw body content for json/text/graphql modes
	formData: KeyValueItem[]; // Fields for form-data mode
	urlEncoded: KeyValueItem[]; // Fields for x-www-form-urlencoded mode

	// Auth
	authType: AuthType;
	authConfig: Record<string, any>;

	// Scripts
	preRequestScript: string;
	testScript: string;
}

// ============================================================================
// Response Types
// ============================================================================

export interface ResponseState {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: string;
	bodyRaw?: string;
	bodyType: "json" | "html" | "xml" | "text" | "binary";
	size: number;
	time: number;
	timestamp?: string;
	errorCode?: string;
	errorMessage?: string;
	consoleLogs?: string[];
	testResults?: Array<{ name: string; passed: boolean; error?: string }>;
	preScriptError?: string;
	postScriptError?: string;
}

// ============================================================================
// Context Types
// ============================================================================

export interface RequestBuilderContextValue {
	// Request State
	request: RequestState;
	setRequest: (request: Partial<RequestState>) => void;
	updateField: <K extends keyof RequestState>(field: K, value: RequestState[K]) => void;

	// Response State
	response: ResponseState | null;
	setResponse: (response: ResponseState | null) => void;

	// UI State
	activeTab: RequestTab;
	setActiveTab: (tab: RequestTab) => void;
	isExecuting: boolean;
	isSaving: boolean;
	hasUnsavedChanges: boolean;
	saveStatus: "idle" | "pending" | "saving" | "saved" | "error";

	// Variable Resolution
	resolveString: (input: string) => string;
	resolveVariables: (input: string) => string;
	getVariable: (name: string) => ResolvedVariable | null;
	getAllVariables: () => Record<string, ResolvedVariable>;
	updateVariable: (name: string, value: string, scope: VariableScope) => void;

	// Actions
	executeRequest: () => Promise<void>;
	saveRequest: () => Promise<void>;
	startLoadTest: () => void;
}

// Re-export from centralized types for backward compatibility
export type { ResolvedVariable as VariableInfo, VariableScope } from "@/types";

// ============================================================================
// Component Props Types
// ============================================================================

export interface KeyValueEditorProps {
	items: KeyValueItem[];
	onChange: (items: KeyValueItem[]) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	showResolved?: boolean;
	allowDisable?: boolean;
	readOnly?: boolean;
	keySuggestions?: string[];
	canEdit?: (item: KeyValueItem, field: keyof KeyValueItem) => boolean;
	canRemove?: (item: KeyValueItem) => boolean;
	canDisable?: (item: KeyValueItem) => boolean;
}

export interface ScriptEditorProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	height?: string;
	readOnly?: boolean;
}
