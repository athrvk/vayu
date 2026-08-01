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

// Type-only, and therefore safe despite `body-drafts` importing `BodyMode` back
// from here: `import type` is erased, so no runtime cycle exists.
import type { BodyDrafts } from "./utils/body-drafts";
import type {
	BodyMode,
	ConsoleLogEntry,
	HttpMethod,
	HttpVersion,
	KeyValueEntry,
	RequestAuth,
	ResolvedVariable,
	ResponseTiming,
	ScriptPart,
	VariableOrigin,
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
	/** The request's own documentation. First in the row - see InfoPanel. */
	"info" | "params" | "headers" | "body" | "auth" | "pre-script" | "test-script" | "settings";

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

/**
 * The Content-Type row a body mode added on its way in, so leaving that mode can
 * take it back. Written by `BodyPanel` through the context accessors; the rule
 * that reads it is in `components/RequestTabs/panels/body/content-type.ts`.
 *
 * By **row id**, not by value: `Content-Type: application/json` typed by the
 * user and the identical row this panel wrote look the same and must not be
 * treated the same. `value` is kept beside it so a row the user has since
 * retyped is recognised as no longer ours.
 *
 * Ephemeral, like the body drafts - `requestId` says whose row it is, and a
 * record belonging to another request is dropped rather than applied.
 */
export interface AutoContentType {
	requestId: string | null;
	rowId: string;
	value: string;
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
	/** Protocol to negotiate. See `Request.httpVersion` for the full rationale. */
	httpVersion: HttpVersion;
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
	 * The protocol actually negotiated for this exchange - `"HTTP/2"`,
	 * `"HTTP/1.1"`, etc, or `""` when the transfer never got far enough to
	 * negotiate one (e.g. a connection error). This is a *display* string the
	 * engine reports after the transfer (`response.http_version` /
	 * `Response::http_version` in `engine/src/http/client.cpp`), not a member
	 * of the `HttpVersion` request-side union (`auto` | `http1.1` | `http2`) -
	 * do not unify the two types.
	 */
	httpVersion?: string;
	/**
	 * When this response arrived, ISO. Set on a live send only.
	 *
	 * The pane's status bar reads it as an age - "just now", "4m ago" - which
	 * answers the question a duration cannot: whether what you are looking at is
	 * the response to the request beside it *as it is now*, or to a version of
	 * it from twenty minutes and several edits ago.
	 *
	 * A bare `timestamp` used to live here and was removed for having one writer
	 * and no reader. This one has a reader; that is the whole difference, and
	 * `response-age.test.tsx` is what keeps it true.
	 */
	receivedAt?: string;
	/**
	 * Set only when this response was rebuilt from a stored run rather than sent
	 * just now - a cold start, or a run opened from History. Drives the same age
	 * chip, labelled "from run" so the two cases stay distinguishable: the
	 * request beside it may have been edited since. Gone after the next send.
	 */
	restoredFrom?: RestoredFrom;
	errorCode?: string;
	errorMessage?: string;
	/** A `string` is the pre-structured engine shape - see `parse-logs.ts`. */
	consoleLogs?: Array<ConsoleLogEntry | string>;
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

	/**
	 * What the body modes you are not looking at were holding, so switching mode
	 * does not destroy them. See `utils/body-drafts.ts` for why there are two
	 * buckets and not six.
	 *
	 * Backed by a ref in the provider, for two reasons that pull the same way:
	 * nothing renders from it, so writing it must not cause a re-render
	 * mid-switch; and Radix unmounts an inactive `TabsContent`, so a ref inside
	 * `BodyPanel` would be thrown away the moment you glance at the Headers tab.
	 *
	 * A pair of accessors rather than the ref itself. Handing the ref out means
	 * consumers assign to `.current` on a value they got from context, which the
	 * React compiler's immutability rule rejects - correctly, since a context
	 * value is meant to be read.
	 */
	getBodyDrafts: () => BodyDrafts;
	setBodyDrafts: (drafts: BodyDrafts) => void;

	/**
	 * The Content-Type row `BodyPanel` wrote when a mode required one, so that
	 * leaving the mode can take it back. Behind accessors and living in the
	 * provider for the same reasons as the drafts above - and for one more: the
	 * record has to outlive the panel, or the header outlives the mode that
	 * needed it, which is the bug it exists to fix.
	 */
	getAutoContentType: () => AutoContentType | null;
	setAutoContentType: (auto: AutoContentType | null) => void;

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
	/** Every definition of a name, winner and losers alike. Display-only. */
	getVariableOrigins: (name: string) => VariableOrigin[];
	updateVariable: (name: string, value: string, scope: VariableScope) => void;
	/**
	 * The scopes `updateVariable` can actually write to right now.
	 *
	 * Each of its branches begins with a guard - `if (!activeEnvironmentId)
	 * return`, `if (!collectionId) return` - so writing to a scope with no target
	 * is a silent no-op. Nothing surfaced that, because the only caller edited an
	 * already-resolved variable, which by definition had a target. Creating one
	 * does not, so a scope picker offering "Environment" with none active would
	 * hand the user a Create button that does nothing.
	 */
	writableScopes: VariableScope[];

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
export type { ResolvedVariable as VariableInfo, VariableScope, VariableOrigin } from "@/types";

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
