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
 *
 * The key/value row model (`KeyValueItem`) and the table's props
 * (`KeyValueEditorProps`) used to live here. They moved to `types/ui.ts` with
 * the table itself (issue #567): a primitive under `components/shared/` cannot
 * take its props type from a feature module. Import them from `@/types` - there
 * is deliberately no re-export shim here, so there is one path to each name.
 */

// Type-only, and therefore safe despite `body-drafts` importing `BodyMode` back
// from here: `import type` is erased, so no runtime cycle exists.
import type { BodyDrafts, VariablesDraft } from "./utils/body-drafts";
import type {
	BodyMode,
	ConsoleLogEntry,
	HttpMethod,
	HttpVersion,
	KeyValueItem,
	RequestAuth,
	ResolvedVariable,
	ResponseTiming,
	ScriptPart,
	StreamEndReason,
	StreamEvent,
	VariableOrigin,
	VariableScope,
} from "@/types";

// ============================================================================
// Tab Types
// ============================================================================

export type RequestTab =
	/** The request's own documentation. First in the row - see InfoPanel. */
	| "info"
	| "params"
	| "headers"
	| "body"
	| "auth"
	| "pre-script"
	| "test-script"
	/** Saved example responses (issue #481). Read-only, populated by import. */
	| "examples"
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

/**
 * A header row a *setting* added on its way in, so leaving that setting can
 * take it back. Two settings own one each: the body mode's `Content-Type`
 * (written by `BodyPanel`) and the Event stream toggle's `Accept` (written by
 * `SettingsPanel`). Both go through the context accessors; the rule that reads
 * them is in `utils/auto-header.ts`.
 *
 * By **row id**, not by value: `Content-Type: application/json` typed by the
 * user and the identical row a panel wrote look the same and must not be
 * treated the same. `value` is kept beside it so a row the user has since
 * retyped is recognised as no longer ours. The header *name* is not stored -
 * each record lives in a slot dedicated to one header, and the rule is told
 * which name it is working on.
 *
 * Ephemeral, like the body drafts - `requestId` says whose row it is, and a
 * record belonging to another request is dropped rather than applied.
 */
export interface AutoHeader {
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
	/**
	 * Consume this endpoint's response as a `text/event-stream` (issue #574).
	 *
	 * Not a {@link BodyMode}: the request's body semantics are untouched, and
	 * a stream is a GET as often as it is a POST. What it changes is the
	 * *execution model* - `POST /execute` answers `202 {runId, eventsUrl}`
	 * instead of the exchange, and the events arrive over
	 * `GET /runs/:id/events`.
	 */
	stream: boolean;
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
	 * This exchange asked for HTTP/2 and negotiated something older. Carried
	 * from the engine rather than compared here against the tab's `httpVersion`
	 * setting - see `HttpResponse.httpVersionDowngraded` in
	 * `app/src/types/domain.ts` for why. Read by the
	 * response status bar, which is the only place a user finds out; before
	 * this, a downgrade was indistinguishable from success.
	 */
	httpVersionDowngraded?: boolean;
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
	/**
	 * The events a streaming request received (issue #574), bounded by the
	 * engine's `sseMaxStoredEvents`. Set only by `restore-response.ts`, from the
	 * stored trace's `events` node - a live stream's rows arrive over the relay
	 * and live in `execution-events-store` until the run finishes and this
	 * replaces them.
	 *
	 * Absent, not empty, on a non-streaming response: the Events tab tells "this
	 * was not a stream" from "this stream produced nothing" by which of the two
	 * it is looking at.
	 */
	events?: StreamEvent[];
	/**
	 * Every event the run received, which is **not** `events.length` when the
	 * stored list was capped. Carried so a reader is never invited to count the
	 * rows and call that the total.
	 */
	totalEvents?: number;
	/** The stored list is a prefix - the engine's own comparison, not derived. */
	eventsTruncated?: boolean;
	/** Why the stream ended. Named, always, rather than left to be inferred. */
	streamEndReason?: StreamEndReason;
}

/**
 * What starting a stream answered (issue #574).
 *
 * A union rather than "the run, or null": a stream that was refused has a real
 * failure to show - the engine names why, and `stream` combined with a script
 * or with `transient` is a `400` a user needs to read - so the failure travels
 * as the response it should render, not as an absence the caller has to invent
 * a message for. `null` stays reserved for "there was nothing to send".
 */
export type StreamStartResult =
	| { ok: true; runId: string; eventsUrl: string }
	| { ok: false; response: ResponseState };

// ============================================================================
// Context Types
// ============================================================================

export interface RequestBuilderContextValue {
	// Request State
	request: RequestState;
	setRequest: (request: Partial<RequestState>) => void;
	updateField: <K extends keyof RequestState>(field: K, value: RequestState[K]) => void;

	/**
	 * Put the stored name back on screen, discarding whatever the name field
	 * currently holds.
	 *
	 * The Info tab's blank-name refusal is the reader: a request must keep a
	 * name, so an emptied field is rejected on blur and the saved name returns.
	 * Only the provider knows what that is - it is the last value the request
	 * query delivered, which is not `request.name` (the user just cleared that)
	 * and not a re-read of the cache (this layer does not fetch).
	 */
	restoreStoredName: () => void;

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
	getVariablesDraft: () => VariablesDraft | null;
	setVariablesDraft: (draft: VariablesDraft) => void;

	/**
	 * The Content-Type row `BodyPanel` wrote when a mode required one, so that
	 * leaving the mode can take it back. Behind accessors and living in the
	 * provider for the same reasons as the drafts above - and for one more: the
	 * record has to outlive the panel, or the header outlives the mode that
	 * needed it, which is the bug it exists to fix.
	 */
	getAutoContentType: () => AutoHeader | null;
	setAutoContentType: (auto: AutoHeader | null) => void;

	/**
	 * The same, for the `Accept: text/event-stream` row the Event stream toggle
	 * writes (issue #574). A second slot rather than one keyed by header name:
	 * there are exactly two settings that own a header, each owns a different
	 * one, and a map would let a caller read the wrong record by passing the
	 * wrong string.
	 */
	getAutoAccept: () => AutoHeader | null;
	setAutoAccept: (auto: AutoHeader | null) => void;

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
	/**
	 * A stream this builder started is still open (issue #574).
	 *
	 * Distinct from `isExecuting`, which the streaming send clears the moment
	 * the engine answers `202`: there is no request in flight any more, and the
	 * response pane must render rather than sit on a spinner while the events
	 * arrive. This is what turns Send into Stop and what the status band reads.
	 */
	isStreaming: boolean;
	/**
	 * Stop the stream this builder started, at the engine
	 * (`POST /runs/:id/stop`). A no-op when nothing is streaming - the button
	 * that calls it is only rendered while one is.
	 */
	stopStream: () => Promise<void>;
	isSaving: boolean;
	hasUnsavedChanges: boolean;
	saveStatus: "idle" | "pending" | "saving" | "saved" | "error";

	// Variable Resolution
	resolveString: (input: string) => string;
	resolveVariables: (input: string) => string;
	/**
	 * The auth this request will actually send - `inherit` walked through the
	 * collection chain, `{{variables}}` resolved - or null for none.
	 *
	 * Preview only, never sent: execution resolves engine-side (`POST /compose`).
	 * Read by the GraphQL schema cache, whose identity has to move when the
	 * credentials do, including when they move somewhere upstream of this
	 * request (#383).
	 */
	resolvedAuth: Record<string, unknown> | null;
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

export interface ScriptEditorProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	height?: string;
	readOnly?: boolean;
}
