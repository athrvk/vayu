
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilder Types
 *
 * Centralized type definitions for the request builder module
 */

import type { HttpMethod } from "@/types";

// ============================================================================
// Key-Value Types (shared across params, headers, form-data)
// ============================================================================

export interface KeyValueItem {
	id: string;
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
	system?: boolean;
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

export type AuthType = "none" | "bearer" | "basic" | "api-key";

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

	// Body (flattened for easier access)
	bodyMode: BodyMode;
	body: string; // Raw body content (JSON, text)
	formData: KeyValueItem[];
	urlEncoded: KeyValueItem[];

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
	bodyRaw?: string;  // Raw response body from server (always available, even for non-JSON)
	bodyType: "json" | "html" | "xml" | "text" | "binary";
	size: number;
	time: number;
	timestamp?: string;
	// Script execution results
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
	getVariable: (name: string) => VariableInfo | null;
	getAllVariables: () => Record<string, VariableInfo>;
	updateVariable: (name: string, value: string, scope: VariableScope) => void;

	// Actions
	executeRequest: () => Promise<void>;
	saveRequest: () => Promise<void>;
	startLoadTest: () => void;
}

export interface VariableInfo {
	value: string;
	scope: VariableScope;
}

export type VariableScope = "global" | "collection" | "environment";

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
	keySuggestions?: string[]; // Optional autocomplete suggestions for the key field
	// Callbacks for controlling editability - allows parent to control behavior (loose coupling)
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
