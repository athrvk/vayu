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
	RequestAuth,
	ResolvedVariable,
	ResponseTiming,
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

/**
 * The builder holds the domain {@link RequestAuth} verbatim - `mode`, and
 * `apikey`'s `in`. It used to carry a second, flat vocabulary of its own
 * (`AuthType` + `AuthConfigState`, where `apikey` was `api-key` and `in` was
 * `addTo`), which existed only so the Auth tab could edit it, and which a
 * translation layer had to keep in step with the domain on every load, save and
 * execute. One shape means the shared `AuthFields` editor serves this host and
 * the collection editor unchanged, and nothing can be lost in translation.
 *
 * `digest` / `aws` / `ntlm` are not offered in the picker - the engine cannot
 * resolve them - but a request can be stored with one (imports produce them), so
 * the union carries them and the panel surfaces them rather than collapsing them
 * to "none" and rewriting them away on the next autosave.
 */
export type { RequestAuth };

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
	auth: RequestAuth;

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
 * Per-request timing breakdown. Declared once in the domain types (it is the
 * `POST /execute` wire shape) and re-exported here for the builder's consumers.
 * Present on a live execute, and again when a response is restored from the
 * last stored design run (`restore-response.ts`).
 */
export type { ResponseTiming } from "@/types";

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
