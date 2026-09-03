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
import type { SendWithRowState } from "./hooks/useSendWithRow";
import type {
	BodyMode,
	ConsoleLogEntry,
	DataContractScope,
	HttpMethod,
	HttpVersion,
	KeyValueItem,
	RequestAuth,
	ResolvedVariable,
	ResponseTiming,
	ScriptPart,
	TestResult,
	StreamEndReason,
	StreamEvent,
	VariableOrigin,
	VariableScope,
	ResponseValidation,
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
 * record belonging to another request is dropped rather than applied. The
 * provider keeps one record per request (issue #1269), so the rule reading this
 * one is normally handed the record it owns; the check stays because the rule
 * is a pure function that cannot know that.
 */
export interface AutoHeader {
	requestId: string | null;
	rowId: string;
	value: string;
}

/**
 * The method a body mode set, and what it was before (issue #1228).
 *
 * The same reversible-side-effect rule as {@link AutoHeader}, on the one field
 * that is not a header row: GraphQL over `GET` is sent as query parameters and
 * cannot carry a mutation at all, so choosing the mode on a request still
 * holding the default `GET` sets `POST` - and leaving the mode puts `GET` back.
 *
 * `method` is what this record set, and it is re-checked before the revert for
 * the reason `AutoHeader` keeps `value`: a method the user has picked since is
 * theirs, and reverting it would take a choice away rather than complete one.
 */
export interface AutoMethod {
	requestId: string | null;
	method: HttpMethod;
	previous: HttpMethod;
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
	/**
	 * Names of the engine's own default headers this send refuses (issue #1229),
	 * ticked off in the Headers tab's "Added by Vayu" group and sent as
	 * `disabledDefaultHeaders`.
	 *
	 * **None of it is persisted.** It is a property of this send, not of the
	 * request: the defaults are resolved from engine config at send time, so a
	 * saved opt-out would be a stored answer to a question config re-answers on
	 * every send - which is the whole defect #1229 removes. `handleSave` writes
	 * no such field, and there is none on `Request` to write it to.
	 */
	disabledDefaultHeaders: string[];

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
	/** Verify the TLS certificate. See `Request.verifySSL` for the rationale. */
	verifySSL: boolean;
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
	 * notice in the response viewer; re-sending fetches the body again - up to
	 * `maxDesignResponseBodyBytes`, which is the separate limit `bodyCapped`
	 * below reports.
	 *
	 * Only the restore funnel sets it: a live send has nothing stored yet.
	 */
	bodyTruncated?: boolean;
	/** The response body's original byte length, present only when truncated. */
	bodyBytes?: number;
	/**
	 * The engine only ever *read* this much of the body, stopping at
	 * `maxDesignResponseBodyBytes` (issue #1157).
	 *
	 * Both funnels set it - the live send from `bodyCapped` on the `/execute`
	 * body, a restored one from `trace.response.bodyCapped` - and it is a
	 * different fact from `bodyTruncated` above, so the two notices must not be
	 * worded alike and are not exclusive. Storage truncation shortened a body
	 * that was received whole, so re-sending recovers it; a capped read never
	 * fetched the rest, so re-sending reproduces it and the remedy is raising
	 * the limit.
	 */
	bodyCapped?: boolean;
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
	 * The client-certificate registry entry this exchange presented, as `host`
	 * or `host:port` (issue #707); absent when none matched.
	 *
	 * Read by the response status bar. A per-host certificate registry makes
	 * "why does this call work here and fail there" a question the request
	 * itself cannot answer - nothing on it names a certificate - so the
	 * exchange has to say which entry it used.
	 */
	clientCertificate?: string;
	/**
	 * What checking this response against its declared schema found (issue
	 * #628), or absent when the request's collection is bound to no document -
	 * "never judged against a contract" and "judged and failed" being different
	 * answers the pane must not spell the same way.
	 *
	 * Set by **both** response funnels - `responseFromExecuteResult` from the
	 * live `/execute` body and `responseFromRunResult` from the stored trace -
	 * because a restored response must show the verdict the live one did. That
	 * pair is the copy-does-not-receive-the-fix trap this codebase keeps
	 * finding; the engine writes the same object to both places so neither side
	 * recomputes anything.
	 */
	validation?: ResponseValidation;
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
	/**
	 * Every assertion the request's two scripts made, in execution order, each
	 * naming its script (issue #810). The engine's own shape, shared with the
	 * stored trace's `scripts` node rather than restated here - a second copy of
	 * a shape is a second place a field can go missing.
	 */
	testResults?: TestResult[];
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
	 * Which of the engine's own default headers this send refuses (issue #1229).
	 *
	 * Separate from `updateField` because it is the one piece of `RequestState`
	 * that is never saved: routing it through the ordinary setter would mark the
	 * tab as having unsaved changes, and autosave would then write a request
	 * whose stored fields nobody touched.
	 */
	setDisabledDefaultHeaders: (names: string[]) => void;

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
	 *
	 * These accessors answer for the request on screen, and each slot holds one
	 * record per request (issue #1269) - one provider serves every request tab,
	 * so a slot holding a single record stranded the header the app had added to
	 * whichever request entered the mode first.
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

	/**
	 * The method the GraphQL body mode set, so leaving the mode can put back
	 * the one it replaced (issue #1228). A third slot beside the two above,
	 * and deliberately not one of them: what it owns is a scalar field rather
	 * than a header row, so it records the value it wrote instead of a row id.
	 */
	getAutoMethod: () => AutoMethod | null;
	setAutoMethod: (auto: AutoMethod | null) => void;

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
	/**
	 * The data contract in scope for this request's collection, or undefined
	 * when nothing in its chain declares one (issue #600).
	 *
	 * Resolved here rather than by the inputs that paint against it: the
	 * provider already holds the collections, and a token painter reaching for
	 * the query cache itself would make `VariableInput` unrenderable without a
	 * `QueryClientProvider` - the same coupling the `VariableSupport` prop
	 * removed for the variable slice (#564).
	 */
	dataColumns?: DataContractScope;
	/**
	 * The rows a single Send can bind, for this request (issue #601).
	 *
	 * Held by the provider rather than the URL bar since issue #1062, because the
	 * preview needs the picked row as much as the picker does: the resolver that
	 * paints the URL, the params and the body lives here, and a row it never sees
	 * is a preview of the environment's value for a name the send answers from
	 * the file. The file behind it is still read only when the picker opens.
	 */
	sendWithRow: SendWithRowState;
	/**
	 * The row index this request was last sent with, or null - "the row I am
	 * iterating on", session-lived and keyed per request (issues #601, #659).
	 */
	lastRowIndex: number | null;
	/** Remember the row just picked, for the preview and the next Send. */
	rememberRowIndex: (index: number) => void;

	// Actions
	/**
	 * Send the request. With `dataRow`, this is a Send-with-row (issue #601):
	 * the row binds every `{{data.column}}` in the request and both scripts read
	 * it as `pm.iterationData`, without a collection run existing.
	 */
	executeRequest: (dataRow?: Record<string, unknown>) => Promise<void>;
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
