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

import type {
	BodyMode,
	HttpMethod,
	KeyValueEntry,
	OAuth2Config,
	ResolvedVariable,
	ScriptPart,
	VariableScope,
} from "@/types";

// ============================================================================
// Key-Value Types (shared across params, headers, form-data)
// ============================================================================

/**
 * UI-layer extension of KeyValueEntry with a stable React key (`id`).
 * The `id` is ephemeral - it is NOT persisted to the backend.
 * Strip it with `toKeyValueEntries()` before sending to the API.
 */
export interface KeyValueItem extends KeyValueEntry {
	id: string;
	system?: boolean; // true = row is managed by the system (e.g. X-Request-ID)
}

// ============================================================================
// Tab Types
// ============================================================================

export type RequestTab =
	| "params"
	| "headers"
	| "body"
	| "auth"
	| "pre-script"
	| "test-script"
	| "settings";

export interface TabInfo {
	id: RequestTab;
	label: string;
	badge?: number;
}

// ============================================================================
// Auth Types
// ============================================================================

export type AuthType = "none" | "inherit" | "bearer" | "basic" | "api-key" | "oauth2";

/**
 * Flat auth fields backing the request builder's Auth tab. Which fields are
 * populated depends on the active {@link AuthType}. The Auth tab, request
 * execution, and the curl importer all read/write this flat shape. OAuth 2.0
 * keeps its (larger) config in a nested object rather than flattening it.
 */
export interface AuthConfigState {
	token?: string;
	username?: string;
	password?: string;
	key?: string;
	value?: string;
	addTo?: "header" | "query";
	oauth2?: OAuth2Config;
}

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

// Re-export the canonical domain BodyMode so existing module-relative imports
// (BodyPanel, parseCurl) keep resolving from "../types".
export type { BodyMode };

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
	authConfig: AuthConfigState;

	// Scripts
	preRequestScript: string;
	testScript: string;

	// Execution settings (Settings tab)
	followRedirects: boolean;
	maxRedirects: number;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Per-request timing breakdown (milliseconds). Phase fields (dns…download) are
 * sequential segments of the request; `wire` is libcurl's transfer time and
 * `queueWait` is generator-side overhead (total − wire).
 *
 * Present on a live execute, and again when a response is restored from the
 * last stored design run - the engine writes the five phases into that run's
 * trace (`store_result`, engine/src/http/routes/execution.cpp). `wire` and
 * `queueWait` are the two the design-mode writer omits, so they are absent on a
 * restored response; every consumer must treat both as optional.
 */
export interface ResponseTiming {
	total: number;
	wire?: number;
	queueWait?: number;
	dns: number;
	connect: number;
	tls: number;
	firstByte: number;
	download: number;
}

/** Which stored run a response was rebuilt from, and when that run happened. */
export interface RestoredFrom {
	runId?: string;
	/** ISO timestamp of the run result. */
	at: string;
}

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
	/**
	 * Set when this response was restored from a stored run whose body the engine
	 * truncated for storage (`maxTraceBodyBytes`). `body` then holds only the
	 * stored slice, and `bodyBytes` is the original length. Drives the truncation
	 * notice in the response viewer; re-sending fetches the full body.
	 */
	bodyTruncated?: boolean;
	/** The response body's original byte length, present only when truncated. */
	bodyBytes?: number;
	time: number;
	timing?: ResponseTiming;
	/**
	 * Set only when this response was rebuilt from a stored run rather than sent
	 * just now - a cold start, or a run opened from History. Drives the pane's
	 * age chip, which is the only thing that tells the two apart: the request
	 * beside it may have been edited since. Gone after the next send.
	 *
	 * This replaced a bare `timestamp` that had one writer and no reader.
	 */
	restoredFrom?: RestoredFrom;
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

	/**
	 * Collection script parts to list as "runs before your own", overriding the
	 * live collection chain. Set only by the History run view, which shows what
	 * a stored run recorded; undefined everywhere else, where the script panels
	 * walk the chain themselves.
	 */
	inheritedPreScripts?: ScriptPart[];
	inheritedPostScripts?: ScriptPart[];

	/**
	 * The whole glued script a pre-script-parts run recorded. Set only by the
	 * History run view; the editor is empty for such a run, so this is the only
	 * place its script text appears.
	 */
	legacyPreScript?: string;
	legacyPostScript?: string;

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
	/**
	 * Whether this builder can start a load test at all. False for a detached
	 * copy (a past design run replayed in the builder), which is given no
	 * `onStartLoadTest` - so the UrlBar hides the Load Test button rather than
	 * showing one that does nothing.
	 */
	canStartLoadTest: boolean;
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
