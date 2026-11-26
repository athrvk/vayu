/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's types. The key/value row model (`KeyValueItem`) and table props
 * (`KeyValueEditorProps`) live in `types/ui.ts` (#567), since a `components/shared/` primitive
 * cannot take its props type from a feature module; import them from `@/types`. No re-export shim
 * here, so each name has one path.
 */

// Type-only, so safe though `body-drafts` imports `BodyMode` back: `import type` is erased, so no
// runtime cycle.
import type { BodyDrafts, VariablesDraft } from "./utils/body-drafts";
import type { BulkDraft, BulkDrafts, BulkTable } from "./utils/bulk-drafts";
import type { HeaderLine as WireHeaderLine } from "@/components/shared/response-viewer/wire-headers";
import type { ResponseBytes } from "./utils/response-bytes";
import type { SendWithRowState } from "./hooks/useSendWithRow";
import type { BoundField, DataFieldContext } from "@/lib/data-bind-escaping";
import type { LeftOutElement } from "@/lib/elements";
import type { EditStatus } from "@/hooks/useSaveManager";
import type { ElementErrors } from "@/components/shared/ElementList/useElementRefusals";
import type {
	BodyMode,
	ConsoleLogEntry,
	FileRef,
	ExampleSentRequest,
	HeaderLine,
	RedirectHop,
	DataContractScope,
	ElementDef,
	ElementOutcome,
	ExchangeWarning,
	HttpMethod,
	HttpVersion,
	KeyValueItem,
	McpTool,
	MethodSource,
	RequestAuth,
	ResolvedElement,
	ResolvedVariable,
	ResponseTiming,
	ScriptRequestRecord,
	TestResult,
	StreamEndReason,
	StreamEvent,
	VariableCreateOptions,
	VariableOrigin,
	VariableScope,
	ResponseValidation,
} from "@/types";

// ============================================================================
// Tab Types
// ============================================================================

export type RequestTab =
	/** The request's own documentation, first in the row (see InfoPanel). */
	| "info"
	| "params"
	| "headers"
	| "body"
	| "auth"
	/**
	 * Extractors, assertions, timers and scripts (#1512); a script is a `script.pre` /
	 * `script.post` element.
	 */
	| "elements"
	/**
	 * Saved example responses (#481): imported or saved from a response; deletable, not editable.
	 */
	| "examples"
	| "settings";

export interface TabInfo {
	id: RequestTab;
	label: string;
	/**
	 * The count beside the label, `undefined` for "nothing to show". The key's *presence* says the
	 * tab can carry a count (`RequestTabs` reads `"badge" in tab`): a present-but-`undefined` badge
	 * still renders `TabCount`, whose track animates open from zero so an arriving count grows in
	 * instead of shifting the next tab. Omitting the key opts out (no `TabCount`, no width), as
	 * Examples does. So `undefined` and omitted differ here.
	 */
	badge?: number;
	/**
	 * A dot instead of the number, for "something here" with nothing to count (#2199); `badge` is
	 * then `1` or `undefined`.
	 */
	presence?: boolean;
}

/** The response pane's own tab strip; see `ResponseViewer`. */
export type ResponseTab =
	"body" | "headers" | "cookies" | "timing" | "console" | "tests" | "events" | "raw-request";

// ============================================================================
// Auth Types
// ============================================================================

/**
 * The builder holds the domain {@link RequestAuth} verbatim (`mode`, and `apikey`'s `in`), so the
 * shared `AuthFields` serves this host and the collection editor unchanged, losing nothing in
 * translation. `digest` / `aws` / `ntlm` are not offered (the engine cannot resolve them), but a
 * request can be stored with one (imports produce them), so the union carries them and the panel
 * surfaces them rather than collapsing them to "none" and rewriting them on the next autosave.
 */
export type { RequestAuth };

// ============================================================================
// Body Types
// ============================================================================

// The domain BodyMode, re-exported so module-relative imports (BodyPanel, parseCurl) resolve from
// "../types".
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
	/**
	 * Which app setting last wrote {@link method}, unclaimed by the user (#1505);
	 * `Request.methodSource` has the rationale and `graphql-method.ts` is the one writer.
	 */
	methodSource?: MethodSource;
	url: string;
	params: KeyValueItem[];
	headers: KeyValueItem[];
	/**
	 * Engine default headers **this send** refuses (#1229), unticked in the Headers tab's "Added by
	 * Vayu" group and sent as `disabledDefaultHeaders`. **Never persisted**: the defaults are
	 * resolved from engine config at send time, so a saved untick would be a stored answer config
	 * re-answers every send, the defect #1229 removes; `handleSave` writes no such field. Not
	 * {@link disabledSystemHeaders}, the *stored* per-request list (Postman's, #1765) edited in
	 * Settings; the engine unions the two.
	 */
	disabledDefaultHeaders: string[];

	// Body (flattened for editor access)
	bodyMode: BodyMode;
	body: string; // Raw body content for json/text/graphql modes
	formData: KeyValueItem[]; // Fields for form-data mode
	urlEncoded: KeyValueItem[]; // Fields for x-www-form-urlencoded mode
	/**
	 * The file a `binary` body sends: a path, never bytes, opened by the engine at send time. Kept
	 * beside the other modes' state like `formData`, so a mode switch and back keeps the pick.
	 * `unresolved` is the engine's last answer, or `false` after a pick here (`FileRef`,
	 * `lib/file-trust.ts`).
	 */
	binaryFile: FileRef;
	/**
	 * The tool an `mcp` body calls, for the engine's `Mcp-Param-*` headers (`McpTool`); absent
	 * stores none. Kept beside the other modes' state like `binaryFile`, so a mode round trip keeps
	 * it; written only in `mcp` mode.
	 */
	mcpTool?: McpTool;

	// Auth
	auth: RequestAuth;

	/**
	 * Extractors, assertions, timers and scripts (#1512), in list order; a script is a `script.pre`
	 * / `script.post` element.
	 */
	elements: ElementDef[];

	// Execution settings (Settings tab)
	followRedirects: boolean;
	maxRedirects: number;
	/**
	 * This request's timeout in ms, or `null` for the `defaultTimeout` setting (`Request.timeout`,
	 * #2937).
	 */
	timeout: number | null;
	/** Protocol to negotiate. See `Request.httpVersion` for the full rationale. */
	httpVersion: HttpVersion;
	/** Verify the TLS certificate. See `Request.verifySSL` for the rationale. */
	verifySSL: boolean;
	/** Skip the cookie jar. See `Request.disableCookies` (issue #1765). */
	disableCookies: boolean;
	/**
	 * The automatic headers this request never sends, **stored** on it (#1765) and edited in
	 * Settings; see `Request.disabledSystemHeaders` and {@link disabledDefaultHeaders}, the
	 * per-send list kept apart.
	 */
	disabledSystemHeaders: string[];
	/** Send the URL as written. See `Request.disableUrlEncoding` (issue #1765). */
	disableUrlEncoding: boolean;
	/**
	 * Consume the response as `text/event-stream` (#574). Not a {@link BodyMode}: body semantics
	 * are untouched, and a stream is a GET as often as a POST. It changes the *execution model*:
	 * `POST /execute` answers `202 {runId, eventsUrl}`, and events arrive over
	 * `GET /runs/:id/events`.
	 */
	stream: boolean;
	/**
	 * The JSONPath each event's JSON `data` is read through for the reply's text (#3773); empty is
	 * none. Meaningful only with {@link stream} on: turning it off clears this (`streamPatch`), as
	 * the engine refuses a path on a non-streaming request.
	 */
	streamTextPath: string;
	/**
	 * The literal a load run's stream is timed to (#3774), matched byte for byte, so never trimmed;
	 * empty is none. Cleared with {@link streamTextPath} when the stream goes off (`streamPatch`).
	 */
	streamFirstContentMarker: string;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Per-request timing, declared once in the domain types (the `POST /execute` wire shape) and
 * re-exported here. Present on a live execute and on a response restored from the last stored
 * design run (`restore-response.ts`).
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
	/**
	 * The response's header lines as received: server's case, one entry per line, repeats kept
	 * (#2460). Read by Headers, Cookies and Raw; `headers` stays the folded map for lookups by
	 * name. Both funnels set it via `receivedHeaderLines` (`responseFromExecuteResult` from
	 * `/execute`'s `headerLines`, `responseFromRunResult` from `trace.response.headerLines`), an
	 * empty list becoming absent in both, so live and restored agree. Absent means none received
	 * (an older engine or row, a stream's `open` frame, a header-less response), never "derive
	 * them": the tabs show `headers`, and Cookies splits its folded `set-cookie`.
	 */
	headerLines?: HeaderLine[];
	/**
	 * The redirect responses followed before this one (#2461): each 3xx's status and header lines,
	 * in arrival order. `headers` and `headerLines` hold the final hop, so a hop's `Set-Cookie` is
	 * readable only here (Cookies' "Set during redirects"), saying what the server sent, not what
	 * the jar kept. Both funnels set it via `receivedRedirects`, reading `[]` as absent: the live
	 * answer always has `[]`, the stored trace writes the key only after a hop, and an older engine
	 * has neither.
	 */
	redirects?: RedirectHop[];
	requestHeaders?: Record<string, string>;
	/**
	 * The request's header lines as sent: one per line, wire order, repeats kept, as typed (#2466);
	 * `requestHeaders` is the same set folded. The Headers tab lists these when it has no wire
	 * frame (`wireRequestHeaders`), so a failed send or a frame-less restored row still shows every
	 * row. Both funnels set it via `sentHeaderLines` (from `/execute`'s `requestHeaderLines`, from
	 * `trace.request.sentHeaderLines`), empty becoming absent. Absent means an older answer: the
	 * tab shows `requestHeaders`, never derived lines.
	 */
	requestHeaderLines?: HeaderLine[];
	rawRequest?: string;
	/**
	 * The request's header lines as they went out, wire order, from the engine's recorded
	 * `rawRequest` (#2464): the transport's own (`Host`, `Accept`, `Content-Length`, the jar's
	 * `Cookie`) beside the author's. The Headers tab's request section lists these when present,
	 * else `requestHeaders`; never sent, never in `pm.request.headers`. Set by **both** funnels,
	 * only for an exchange that got a response: absent on a failed send and on a frame-less
	 * restored row, where `buildRawRequest` fabricates one the engine never reported.
	 */
	wireRequestHeaders?: WireHeaderLine[];
	body: string;
	bodyRaw?: string;
	size: number;
	/**
	 * Set when restored from a stored run whose body the engine truncated for storage
	 * (`maxTraceBodyBytes`): `body` is the stored slice, `bodyBytes` the original length. Drives
	 * the viewer's notice; re-sending fetches it again, up to `maxDesignResponseBodyBytes`, the
	 * separate limit `bodyCapped` reports. Only the restore funnel sets it: a live send has nothing
	 * stored.
	 */
	bodyTruncated?: boolean;
	/**
	 * The body's UTF-8 byte count: the original length when truncated, and on a stored stream the
	 * bytes delivered, which the held body falls short of once `bodyCapped` cut it (#3238, #3770).
	 * Every restored row has it (#3423), a live one never, so it is a size, never a truncation
	 * signal (`bodyTruncated` is).
	 */
	bodyBytes?: number;
	/**
	 * The engine only *read* this much, stopping at `maxDesignResponseBodyBytes` (#1157). Both
	 * funnels set it (live from `/execute`'s `bodyCapped`, restored from
	 * `trace.response.bodyCapped`). A different fact from `bodyTruncated`, so the two notices are
	 * worded apart and not exclusive: storage truncation shortened a body received whole (re-send
	 * recovers it), a capped read never fetched the rest (re-send reproduces it; the remedy is
	 * raising the limit).
	 */
	bodyCapped?: boolean;
	/**
	 * The body's exact bytes, present exactly when the engine sent base64 (#2458), not UTF-8 text.
	 * `body` and `bodyRaw` then hold its decoding (`rawBytes.isText`) or nothing, never the base64.
	 * Both funnels build it with `decodeResponseBody`; Download writes these bytes and the image
	 * preview reads them.
	 */
	rawBytes?: ResponseBytes;
	time: number;
	timing?: ResponseTiming;
	/**
	 * The negotiated protocol (`"HTTP/2"`, `"HTTP/1.1"`, ...), or `""` when the transfer never got
	 * that far (a connection error). A *display* string the engine reports after the transfer
	 * (`Response::http_version`, `engine/src/http/client.cpp`), not the request-side `HttpVersion`
	 * union (`auto` | `http1.1` | `http2`): do not unify them.
	 */
	httpVersion?: string;
	/**
	 * This exchange asked for HTTP/2 and got something older, carried from the engine rather than
	 * compared with the tab's setting (`HttpResponse.httpVersionDowngraded`,
	 * `app/src/types/domain.ts`, says why). The status bar reads it, the only place a user learns
	 * of a downgrade.
	 */
	httpVersionDowngraded?: boolean;
	/**
	 * The request went without the authentication it asked for (a mode the engine does not execute,
	 * #2474, or an empty bearer token or API key name, #3203): the engine's sentence, absent when
	 * there is none. Set by **both** funnels (from the `/execute` body, from
	 * `trace.request.authNotice`) and drawn by `ResponseViewer` as a band above the tabs, so a 401
	 * carries its explanation. See `HttpResponse.authNotice` in `app/src/types/domain.ts`.
	 */
	authNotice?: string;
	/**
	 * What the engine did that the response does not show: a jar cookie left off `Cookie`, a
	 * `Set-Cookie` libcurl discarded (#3307). Absent when none (both funnels read `[]` and a
	 * missing key alike). Set from the `/execute` body and `trace.warnings`; drawn by
	 * `ExchangeWarnings` above the tabs and on a collection run's step card. See
	 * `HttpResponse.warnings` in `app/src/types/domain.ts`.
	 */
	warnings?: ExchangeWarning[];
	/**
	 * The client-certificate registry entry presented, as `host` or `host:port` (#707); absent when
	 * none matched. Read by the status bar: a per-host registry makes "why does this work here and
	 * fail there" unanswerable from the request, which names no certificate, so the exchange says
	 * which it used.
	 */
	clientCertificate?: string;
	/**
	 * What checking the response against its declared schema found (#628), absent when the
	 * collection is bound to no document: "never judged" and "judged and failed" must read
	 * differently. Set by **both** funnels (live `/execute`, stored trace), so a restored response
	 * shows the live verdict; the engine writes one object to both places, so neither side
	 * recomputes (the copy-misses-the-fix trap).
	 */
	validation?: ResponseValidation;
	/**
	 * When this response arrived, ISO; set on a live send only. The status bar shows it as an age
	 * ("just now", "4m ago"), answering what a duration cannot: whether this answers the request as
	 * it is now or a version from several edits ago. `response-age.test.tsx` keeps the reader true.
	 */
	receivedAt?: string;
	/**
	 * When a stream started, epoch ms (#3775): the zero of the Events rows' offsets, the status
	 * bar's clock and Timing's first event. Set on a stream sent this session (on the live
	 * placeholder and carried to the stored response), and from the trace's `startedAt` on a stream
	 * restored from History (#3805; engine clock). Absent for non-streams and for a restored stream
	 * whose row predates the field.
	 */
	sentAt?: number;
	/**
	 * Set only when rebuilt from a stored run (a cold start, a run opened from History). Drives the
	 * age chip, labelled "from run", since the request beside it may have been edited. Gone after
	 * the next send.
	 */
	restoredFrom?: RestoredFrom;
	/**
	 * The request as written when Send was pressed (#1763), `{{vars}}` unresolved, captured then so
	 * edits made while reading stay out. `ResponseViewer/save-as-example.ts` sends it as the
	 * example's `savedFrom`, so a Postman export describes the request that produced it. Set on a
	 * live send only, by `RequestBuilderProvider`, not a funnel: neither `/execute` nor a trace
	 * carries the unresolved request. A stream's copy reloaded at its end gets the snapshot of the
	 * Send whose run id it carries; other restored responses have none, and their example
	 * regenerates on export.
	 */
	sentRequest?: ExampleSentRequest;
	/**
	 * Draft elements in this Send left out of its payload for failing the app's own check (#3066),
	 * which the response must say did not run, so an unfilled check is never read as passed. Set by
	 * the send handlers on a live send's response, buffered or streamed, and on a failed one: it
	 * describes the composed payload, which neither `/execute` nor a trace carries. A streamed send
	 * carries it through `useExecutionEventsStore` to its placeholder and stored response. Absent
	 * when nothing was left out, and on History or cold-start restores.
	 */
	leftOutElements?: LeftOutElement[];
	/**
	 * Header names and the query parameter this send's auth wrote, absent when none: the live
	 * body's top-level keys and the trace's `request` node, built by both funnels. The session
	 * Console's row builder reads them to mask the values (#3634).
	 */
	authHeaders?: string[];
	authQueryParam?: string;
	errorCode?: string;
	errorMessage?: string;
	/** A `string` is the engine's pre-structured shape; see `parse-logs.ts`. */
	consoleLogs?: Array<ConsoleLogEntry | string>;
	/**
	 * Every assertion the two scripts made, in execution order, each naming its script (#810): the
	 * engine's own shape, shared with the trace's `scripts` node, as a second copy is a place a
	 * field goes missing.
	 */
	testResults?: TestResult[];
	preScriptError?: string;
	postScriptError?: string;
	/**
	 * Every `pm.sendRequest` the scripts made (#3633), as the live body and stored `scripts` node
	 * carry it; a console line's `scriptRequest` indexes it.
	 */
	scriptRequests?: ScriptRequestRecord[];
	/**
	 * What each non-script element did (#1512): extractors, assertions, timers, beside
	 * `testResults` (the script kinds' `pm.test` outcomes).
	 */
	elements?: ElementOutcome[];
	/**
	 * The events a streaming request received (#574), bounded by `sseMaxStoredEvents`. Set only by
	 * `restore-response.ts` from the trace's `events` node: live rows arrive over the relay and
	 * live in `execution-events-store` until the run finishes and this replaces them. Absent, not
	 * empty, on a non-stream: the Events tab tells "not a stream" from "a stream with nothing" by
	 * which it sees.
	 */
	events?: StreamEvent[];
	/**
	 * Every event the run received, **not** `events.length` once the stored list is capped, so no
	 * reader counts rows as the total.
	 */
	totalEvents?: number;
	/** The stored list is a prefix: the engine's own comparison, not derived. */
	eventsTruncated?: boolean;
	/**
	 * The reply the text path read, joined over every stored event, so it outlives `events`' cap
	 * (#3773); absent without a path.
	 */
	streamText?: string;
	/** Why the stream ended. Named, always, rather than left to be inferred. */
	streamEndReason?: StreamEndReason;
}

/**
 * What starting a stream answered (#574). A union, not "run or null": a refused stream has a real
 * failure to show (the engine names why; `stream` with a script or `transient` is a `400` to read),
 * so it travels as the response to render, not an absence the caller must word; `null` means
 * nothing to send. `leftOut` is the draft elements the payload omits (#3066), handed to the
 * execution events store for the pane.
 */
export type StreamStartResult =
	| { ok: true; runId: string; eventsUrl: string; leftOut?: LeftOutElement[] }
	| { ok: false; response: ResponseState };

// ============================================================================
// Context Types
// ============================================================================

/**
 * The fields a fetch can report and the draft can diverge from (#1436): all but `id` and
 * `collectionId` (the reset and move gates own those) and `disabledDefaultHeaders` (never
 * persisted, so never changed externally).
 */
export type MergeableRequestField = keyof Omit<
	RequestState,
	"id" | "collectionId" | "disabledDefaultHeaders"
>;

/** A conflicted field's incoming value, by field; see `fieldConflicts`. */
export type RequestFieldConflicts = { [K in MergeableRequestField]?: RequestState[K] };

export interface RequestBuilderContextValue {
	// Request State
	request: RequestState;
	setRequest: (request: Partial<RequestState>) => void;
	updateField: <K extends keyof RequestState>(field: K, value: RequestState[K]) => void;

	/**
	 * Touched fields a fetch (typically an MCP write mid-edit) has since changed (#1436). The
	 * user's value stays in `request` until `takeExternalField` adopts the incoming one; an
	 * untouched field never appears, being adopted silently.
	 */
	fieldConflicts: RequestFieldConflicts;
	/** Adopt the incoming value for one conflicted field, clearing the conflict. */
	takeExternalField: (field: MergeableRequestField) => void;

	/**
	 * Which engine default headers this send refuses (#1229), apart from `updateField` as the one
	 * piece of `RequestState` never saved: the ordinary setter would mark the tab unsaved, and
	 * autosave would write a request nobody touched.
	 */
	setDisabledDefaultHeaders: (names: string[]) => void;

	/**
	 * Put the stored name back, discarding the field's text. The Info tab's blank-name refusal
	 * reads it: an emptied field is rejected on blur and the saved name returns. Only the provider
	 * knows it (the last value the request query delivered), not `request.name` (just cleared) nor
	 * a cache re-read (this layer does not fetch).
	 */
	restoreStoredName: () => void;

	/**
	 * What the unseen body modes hold, so a mode switch loses nothing (`utils/body-drafts.ts` says
	 * why two buckets, not six). A provider ref: nothing renders from it, so writing must not
	 * re-render mid-switch, and Radix unmounts an inactive `TabsContent`, so a `BodyPanel` ref
	 * would be lost on a glance at Headers. Accessors, not the ref: assigning `.current` on a
	 * context value is what the React compiler's immutability rule rejects, rightly.
	 */
	getBodyDrafts: () => BodyDrafts;
	setBodyDrafts: (drafts: BodyDrafts) => void;
	getVariablesDraft: () => VariablesDraft | null;
	setVariablesDraft: (draft: VariablesDraft) => void;

	/**
	 * The on-screen request's open Bulk edit drafts (#3666), under `memoryKey`, so a draft survives
	 * a sub-tab switch, returns with its request and is seen by no other. State, unlike the body
	 * drafts: the textarea renders from it. Send and Save commit an open draft first
	 * (`utils/bulk-drafts.ts`).
	 */
	bulkDrafts: BulkDrafts;
	/** Open, edit, or (null) discard `table`'s draft. */
	setBulkDraft: (table: BulkTable, draft: BulkDraft | null) => void;
	/** The table toggle: write `table`'s draft into the request and close it. */
	commitBulkDraft: (table: BulkTable) => void;

	// Response State
	response: ResponseState | null;
	setResponse: (response: ResponseState | null) => void;

	/**
	 * Collection elements listed as "runs before your own" (#1512), overriding the live chain. Set
	 * only by the History run view (what a stored run recorded); elsewhere
	 * `InheritedElementsNotice` walks the chain.
	 */
	inheritedElements?: ResolvedElement[];

	/**
	 * What the engine refused about one of this request's own elements on the
	 * last save, by element id (#3043); empty once the element is edited.
	 */
	elementErrors: ElementErrors;

	/**
	 * The whole glued script a pre-script-parts run recorded, set only by the History run view; the
	 * editor is empty then, so this is the script's only place.
	 */
	legacyPreScript?: string;
	legacyPostScript?: string;

	/**
	 * The identity this builder's per-request memory files under: the provider's `memoryKey` prop,
	 * else the request's id. One provider serves every request tab, so a component holding its own
	 * state (a revealed secret, a bulk-edit draft, a notice) keeps it across a request switch
	 * unless keyed on this (#3666). Stable over one request's edits and saves; changes only when
	 * another request is shown.
	 */
	memoryKey: string;
	activeTab: RequestTab;
	setActiveTab: (tab: RequestTab) => void;
	/**
	 * A send of the on-screen request is in flight, held per request (#3352) so a request left
	 * mid-send still reads true on return.
	 */
	isExecuting: boolean;
	/**
	 * The in-flight send is buffered, so `cancelSend` can abort it; a stream's start cannot be: the
	 * engine has the run when it answers, and Stop ends it.
	 */
	canCancelSend: boolean;
	/**
	 * Abort the on-screen request's buffered send (#3352): its answer is dropped, the request idle
	 * at once, the previous response kept.
	 */
	cancelSend: () => void;
	/**
	 * A stream this builder started is open (#574). Not `isExecuting`, which the streaming send
	 * clears at the engine's `202`: nothing is in flight then, and the pane must render, not spin,
	 * while events arrive. This turns Send into Stop and feeds the status band.
	 */
	isStreaming: boolean;
	/**
	 * Stop this builder's stream at the engine (`POST /runs/:id/stop`); a no-op when none is open,
	 * as its button only shows while one is.
	 */
	stopStream: () => Promise<void>;
	isSaving: boolean;
	hasUnsavedChanges: boolean;
	/** This request's own edit, not the Dock's app-wide status (#3350). */
	saveStatus: EditStatus;

	// Variable Resolution
	resolveString: (input: string) => string;
	/**
	 * A preview of one field of a known kind, with why the send would refuse the picked row there;
	 * see `useVariableResolver`'s `resolveField`.
	 */
	resolveField: (input: string, context?: DataFieldContext) => BoundField;
	resolveVariables: (input: string) => string;
	/**
	 * The auth this request sends (`inherit` walked, `{{variables}}` resolved), or null. Preview
	 * only, never sent: execution resolves engine-side (`POST /compose`). The GraphQL schema cache
	 * reads it, as its identity must move with the credentials, including upstream of this request
	 * (#383).
	 */
	resolvedAuth: Record<string, unknown> | null;
	getVariable: (name: string) => ResolvedVariable | null;
	getAllVariables: () => Record<string, ResolvedVariable>;
	/** Every definition of a name, winner and losers alike. Display-only. */
	getVariableOrigins: (name: string) => VariableOrigin[];
	/** As `VariableSupport.updateVariable`: an edit's `sourceId` picks the definition written. */
	updateVariable: (
		name: string,
		value: string,
		scope: VariableScope,
		sourceId?: string,
		options?: VariableCreateOptions
	) => void;
	/**
	 * The scopes `updateVariable` can write now. Its branches guard on a target
	 * (`if (!activeEnvironmentId) return`, `if (!collectionId) return`), so writing a scope without
	 * one is a silent no-op; a picker offering "Environment" with none active would give a Create
	 * button that does nothing.
	 */
	writableScopes: VariableScope[];
	/**
	 * The data contract in scope, undefined when nothing in the chain declares one (#600). Resolved
	 * here, not by the painting inputs: the provider holds the collections, and a painter querying
	 * the cache would make `VariableInput` unrenderable without a `QueryClientProvider`, the
	 * coupling the `VariableSupport` prop removed (#564).
	 */
	dataColumns?: DataContractScope;
	/**
	 * Names the engine left written because a pre-request script runs first (`POST /compose`,
	 * #2521), which token painters stop painting as stored values (#2741). Fetched once here, only
	 * while the request has a `{{token}}`: painters are per editor, and `VariableInput` must render
	 * without a `QueryClientProvider`, as for `dataColumns`.
	 */
	deferredVariables?: readonly string[];
	/**
	 * The rows a single Send can bind (#601), held by the provider (#1062): the resolver painting
	 * the URL, params and body lives here, and a row it never saw would preview the environment's
	 * value for a name the send answers from the file. The file is read only when the picker opens.
	 */
	sendWithRow: SendWithRowState;
	/**
	 * The row index last sent with, or null: "the row I am iterating on", session-lived, per
	 * request (#601, #659).
	 */
	lastRowIndex: number | null;
	/** Remember the row just picked, for the preview and the next Send. */
	rememberRowIndex: (index: number) => void;

	/**
	 * Send the request. With `dataRow` it is a Send-with-row (#601): the row binds every
	 * `{{data.column}}` and both scripts read it as `pm.iterationData`, with no collection run.
	 */
	executeRequest: (dataRow?: Record<string, unknown>) => Promise<void>;
	saveRequest: () => Promise<void>;
	startLoadTest: () => void;
	/**
	 * Whether this builder can start a load test: false for a detached copy (a past design run in
	 * the builder), given no `onStartLoadTest`, so the UrlBar hides Load Test rather than show a
	 * dead button.
	 */
	canStartLoadTest: boolean;
}

// Re-exported from the central types under the builder's names.
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
