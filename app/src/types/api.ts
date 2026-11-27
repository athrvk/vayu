/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// API Request/Response Types

import type {
	Collection,
	CollectionDataSchema,
	CollectionOpenApiBinding,
	DataFileLocation,
	DeclaredOperation,
	ResponseSchemaIndex,
	SpecFileLocation,
	SpecOperation,
	MethodSource,
	MockResponseMode,
	Request,
	Environment,
	Run,
	RunOrigin,
	SanityResult,
	RunReport,
	EngineHealth,
	VariableValue,
	KeyValueEntry,
	HeaderLine,
	FormFieldEntry,
	RequestBody,
	RequestAuth,
	OAuth2Config,
	LoadTestMode,
	ElementDef,
	ResolvedElement,
	HttpVersion,
	RunThresholds,
	RunMonitorConfig,
} from "./domain";

// API Response wrapper
export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
}

// OAuth 2.0 token endpoints
export interface OAuth2InteractiveExchange {
	code: string;
	codeVerifier: string;
	redirectUri: string;
}

export interface OAuth2TokenRequest {
	config: OAuth2Config;
	force?: boolean;
	interactive?: OAuth2InteractiveExchange;
	/**
	 * The scopes a `jwt_bearer` `privateKey` reference resolves against: the active environment and
	 * the request's collection. The rest of `config` is sent resolved; a request naming neither
	 * carries a key file or no `jwt_bearer` grant (#3632).
	 */
	environmentId?: string;
	collectionId?: string;
}

export interface OAuth2TokenResponse {
	cacheKey: string;
	accessToken: string;
	tokenType: string;
	scope?: string;
	expiresIn: number;
	createdAt: number;
	expiresAt: number | null;
	hasRefreshToken: boolean;
}

export interface OAuth2TokenStatusResponse {
	found: boolean;
	expired?: boolean;
	token?: OAuth2TokenResponse;
}

export type OAuth2AuthorizeMode = "loopback" | "embedded";

export interface OAuth2AuthorizeStartRequest {
	config: OAuth2Config;
	mode?: OAuth2AuthorizeMode;
}

export interface OAuth2AuthorizeStartResponse {
	attemptId: string;
	authorizeUrl: string;
	redirectUri: string;
	/** Epoch ms at which the engine fails the attempt: the one deadline both branches wait on. */
	expiresAt: number;
	/** What a discovered attempt (`discoverUrl`) runs on and exchanges its code with; absent otherwise. */
	resolved?: OAuth2AuthorizeResolved;
}

/** `POST /oauth2/authorize/start`'s `resolved`: no secret is ever in it. */
export interface OAuth2AuthorizeResolved {
	authorizationUrl: string;
	accessTokenUrl: string;
	clientId: string;
	resource: string;
	/** `""` when discovery chose none. */
	scope: string;
	issuer: string;
}

/** `POST /oauth2/step-up`: classify a 401/403's challenge; the engine sends and retries nothing. */
export interface OAuth2StepUpRequest {
	/** Each `WWW-Authenticate` line's value, in the order received. */
	wwwAuthenticate: string[];
	/** The scopes already requested, space-separated. */
	scope?: string;
}

export interface OAuth2StepUpResponse {
	/** True only for a Bearer challenge whose `error` is exactly `insufficient_scope`. */
	stepUp: boolean;
	error: string;
	/** The challenge's `scope`, split and deduplicated; `[]` unless `stepUp`. */
	requiredScopes: string[];
	/** What a re-authorization asks for: the held scopes plus the required ones; `""` unless `stepUp`. */
	scope: string;
	description: string;
}

export interface OAuth2AuthorizeStatusResponse {
	state: "pending" | "completed" | "failed" | "not_found";
	error?: string;
	cacheKey?: string;
}

// Collections API
export interface ListCollectionsResponse {
	collections: Collection[];
}

export interface CreateCollectionRequest {
	/**
	 * Never sent: the engine assigns every id and 400s a create carrying one (#97). `never`, not
	 * omitted, so a literal with an `id` fails at the call site; `apiService.createCollection` also
	 * strips it, for spreads the type system cannot see.
	 */
	id?: never;
	name: string;
	description?: string;
	parentId?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	elements?: ElementDef[];
	dataSchema?: CollectionDataSchema;
	/** The spec document to bind at create time - see {@link Collection.openapi}. */
	openapi?: CollectionOpenApiBinding;
	/** See {@link Collection.specFile}. */
	specFile?: SpecFileLocation;
	/** See {@link Collection.dataFile}. */
	dataFile?: DataFileLocation;
}

export interface UpdateCollectionRequest {
	id: string;
	name?: string;
	description?: string;
	/**
	 * `string | null`: the engine reads absent as "keep the parent" and JSON `null` as "move to the
	 * root", so a move out of a nested collection needs a null that reaches the wire.
	 */
	parentId?: string | null;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	elements?: ElementDef[];
	/**
	 * `| null` by `parentId`'s rule: absent keeps the declared contract, `null` resets to none, so
	 * **Clear** is only expressible as a null that reaches the wire.
	 */
	dataSchema?: CollectionDataSchema | null;
	/**
	 * Unbind only: `null` (or `{}`) unbinds, absent keeps the binding, and anything else is a 400
	 * (#3348). Binding restamps the collection's requests, so it is `POST /specs/bind`
	 * (`useBindSpecMutation`).
	 */
	openapi?: Record<string, never> | null;
	/**
	 * The picked spec file and the data file, `| null` as `openapi` is: absent keeps the stored
	 * location, `null` forgets it. Each object is replaced whole, never merged.
	 */
	specFile?: SpecFileLocation | null;
	dataFile?: DataFileLocation | null;
}

// Requests API
export interface ListRequestsParams {
	collectionId?: string;
	/**
	 * `"summary"` answers each row as a `RequestSummary` (#2546). Set only by
	 * `apiService.listRequestSummaries`, so the row type follows the method, not a flag a caller
	 * could pass to the wrong one.
	 */
	fields?: "summary";
}

export interface ListRequestsResponse {
	requests: Request[];
}

export interface CreateRequestRequest {
	/** Engine-assigned - see CreateCollectionRequest.id. */
	id?: never;
	collectionId: string;
	name: string;
	description?: string;
	method: string;
	url: string;
	params?: KeyValueEntry[];
	headers?: KeyValueEntry[];
	body?: RequestBody;
	bodyType?: string;
	auth?: RequestAuth;
	elements?: ElementDef[];
	followRedirects?: boolean;
	maxRedirects?: number;
	/** See {@link Request.timeout}. Absent or `null` stores none. */
	timeout?: number | null;
	httpVersion?: HttpVersion;
	/** Verify the TLS certificate - see {@link Request.verifySSL}. */
	verifySSL?: boolean;
	/** Consume the response as an event stream - see {@link Request.stream}. */
	stream?: boolean;
	/** See {@link Request.streamTextPath}. Needs `stream: true`; absent or `null` stores none. */
	streamTextPath?: string | null;
	/** See {@link Request.streamFirstContentMarker}. Needs `stream: true`; absent or `null` stores none. */
	streamFirstContentMarker?: string | null;
	/** Skip the cookie jar - see {@link Request.disableCookies}. */
	disableCookies?: boolean;
	/** Stored automatic-header opt-outs - see {@link Request.disabledSystemHeaders}. */
	disabledSystemHeaders?: string[];
	/** Send the URL unencoded - see {@link Request.disableUrlEncoding}. */
	disableUrlEncoding?: boolean;
	/**
	 * Postman's `protocolProfileBehavior`, verbatim; see {@link Request.postmanProtocolBehavior}.
	 * The engine takes an object too, but only the stored text keeps the source's member order.
	 */
	postmanProtocolBehavior?: string | Record<string, unknown> | null;
	/** Which spec operation this request is - see {@link Request.specOperation}. */
	specOperation?: SpecOperation;
	/** Which app setting wrote `method` - see {@link Request.methodSource}. */
	methodSource?: MethodSource;
	order?: number;
}

export interface UpdateRequestRequest {
	id: string;
	/**
	 * The collection to move this request to. The engine 400s an id naming no collection rather
	 * than strand the row; a move with no `order` appends in the destination.
	 */
	collectionId?: string;
	name?: string;
	description?: string;
	method?: string;
	url?: string;
	params?: KeyValueEntry[];
	headers?: KeyValueEntry[];
	body?: RequestBody;
	bodyType?: string;
	auth?: RequestAuth;
	elements?: ElementDef[];
	followRedirects?: boolean;
	maxRedirects?: number;
	/** See {@link Request.timeout}. Absent keeps it; `null` resets it to `defaultTimeout`. */
	timeout?: number | null;
	httpVersion?: HttpVersion;
	/** Verify the TLS certificate - see {@link Request.verifySSL}. */
	verifySSL?: boolean;
	/** Consume the response as an event stream - see {@link Request.stream}. */
	stream?: boolean;
	/**
	 * See {@link Request.streamTextPath}. Absent keeps the path, `null` clears it; a string needs
	 * `stream: true` once the write lands.
	 */
	streamTextPath?: string | null;
	/** See {@link Request.streamFirstContentMarker}; absent keeps it, `null` clears it. */
	streamFirstContentMarker?: string | null;
	/** Skip the cookie jar - see {@link Request.disableCookies}. */
	disableCookies?: boolean;
	/** Stored automatic-header opt-outs - see {@link Request.disabledSystemHeaders}. */
	disabledSystemHeaders?: string[];
	/** Send the URL unencoded - see {@link Request.disableUrlEncoding}. */
	disableUrlEncoding?: boolean;
	/** See {@link import("./domain").Request.mockResponseMode}. */
	mockResponseMode?: import("./domain").MockResponseMode;
	/**
	 * Absent keeps the stored example, `null` clears it, as `specOperation` below. See
	 * {@link import("./domain").Request.mockExampleId}.
	 */
	mockExampleId?: string | null;
	/** Absent keeps the operation, `null` clears it: stamp and un-stamp are one verb. */
	specOperation?: SpecOperation | null;
	/**
	 * Absent keeps the marker, `null` clears it (as `specOperation`); leaving GraphQL or picking a
	 * method by hand sends the `null`.
	 */
	methodSource?: MethodSource | null;
	order?: number;
}

// Reorder API (POST /reorder)

/**
 * One row's new position in a batch reorder and, when it changes owner, the new owner. `parentId` /
 * `collectionId` follow the single-row `PUT` merge-patch rule (omitted keeps the owner), except
 * that an owner naming no stored collection is a `400`, not a tolerated forward reference, since
 * nothing here is bulk-created.
 */
export type ReorderMove =
	| { type: "collection"; id: string; order: number; parentId?: string | null }
	| { type: "request"; id: string; order: number; collectionId?: string };

/**
 * A parent whose children (sub-collections and requests, one list, #2535) are renumbered dense
 * `0..n-1` before the moves apply. `parentId: null` is the root, stated rather than omitted: the
 * engine refuses an absent `parentId` so a renumber never lands on a scope the caller did not mean.
 */
export interface ReorderNormalize {
	parentId: string | null;
}

export interface ReorderRequest {
	moves: ReorderMove[];
	normalize: ReorderNormalize[];
}

/**
 * One saved example, written from a live response (#588). `order` is not sendable: the engine
 * appends, and a mock serves a matched route's *first* example, so a save must never change what a
 * restarted mock serves. `origin` is always `user` here; a spec sync reads it (#627) to know which
 * rows it may replace.
 */
export interface CreateRequestExampleRequest {
	/** Engine-assigned - see CreateCollectionRequest.id. */
	id?: never;
	name: string;
	status: number;
	headers: KeyValueEntry[];
	body: string;
	/** `""` when the response stated no media type - not a guess. */
	contentType: string;
	origin: "user";
	/**
	 * Whether `body` stops short of the captured response, at the trace's `maxTraceBodyBytes` cap
	 * (#659). Required: this is the one writer that can have a partial body, so omitting it would
	 * claim by omission that the save is complete.
	 */
	bodyTruncated: boolean;
	/**
	 * The exchange as the builder held it at Send (#1763). Create-only: the engine builds the
	 * Postman saved-response shape from it once (`request_examples.postman_response`), so an export
	 * writes the request that was sent, not what it has become. Absent for a response restored from
	 * a stored run, which has no snapshot; the export then regenerates.
	 */
	savedFrom?: ExampleSavedFrom;
}

/**
 * The request as written at Send (#1763): `{{vars}}` unresolved, its own URL before any redirect,
 * path rows included. Stored request-column shapes; the engine's `savedFrom` reader checks only
 * their outer shapes (not a request save's appliers) and maps them as the export maps a request.
 * Auth is deliberately left out.
 */
export interface ExampleSentRequest {
	method: string;
	url: string;
	params: FormFieldEntry[];
	headers: FormFieldEntry[];
	body: RequestBody;
}

/** See {@link CreateRequestExampleRequest.savedFrom}. */
export interface ExampleSavedFrom {
	request: ExampleSentRequest;
	/** The server's own reason phrase; `""` lets the engine use the table's. */
	statusText: string;
	/** Absent writes `responseTime: null`. */
	responseTimeMs?: number;
	/** Epoch ms (0 or more) of arrival, which a cookie's `Max-Age` counts from; absent: now. */
	receivedAt?: number;
}

/** The rows as written - one drop is one transaction, so this is all of them. */
export interface ReorderResponse {
	collections: Collection[];
	requests: Request[];
}

// Environments API
export interface ListEnvironmentsResponse {
	environments: Environment[];
}

export interface CreateEnvironmentRequest {
	/** Engine-assigned - see CreateCollectionRequest.id. */
	id?: never;
	name: string;
	description?: string; // engine accepts this (environments.cpp)
	variables: Record<string, VariableValue>;
	isActive?: boolean;
}

export interface UpdateEnvironmentRequest {
	id: string;
	name?: string;
	variables?: Record<string, VariableValue>;
	isActive?: boolean;
}

// Globals API
export interface GlobalsResponse {
	id: string;
	variables: Record<string, VariableValue>;
	updatedAt: number | string;
}

export interface UpdateGlobalsRequest {
	variables: Record<string, VariableValue>;
}

// Execution API
// Execute Request API - matches /request endpoint
export interface ExecuteRequestRequest {
	method: string;
	url: string;
	// Resolved, enabled-only. The ordered lines are what composition returns (a repeated name stays
	// repeated, #2466); the record is the single-valued form, one line per key.
	headers?: HeaderLine[] | Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;
	/**
	 * The resolved elements for this exchange: the collection chain's root to leaf, then the
	 * request's own, each stamped with its origin (#1512). A script is one at `kind: "script.pre"`
	 * / `"script.post"`; the engine refuses `preRequestScripts` / `postRequestScripts` (400 naming
	 * `elements`).
	 */
	elements?: ResolvedElement[];
	/**
	 * Redirect policy. Omitted, the engine's defaults apply (follow, cap at 10); send them
	 * explicitly so a request that opts out of following sees its 3xx.
	 */
	followRedirects?: boolean;
	maxRedirects?: number;
	/**
	 * Whole-transfer deadline, ms, present only when the composed request states one (#2937).
	 * Absent, the engine reads `defaultTimeout` at send time, which is why it is the one setting
	 * here never sent at its default.
	 */
	timeout?: number;
	/**
	 * Protocol to negotiate. Sent on *every* execute, never elided at the default, like the
	 * redirect policy: an omitted field lets an engine default win silently, which the client must
	 * not hand over. Both engine clients (renderer and MCP) must agree; see CLAUDE.md's
	 * request-composition section.
	 */
	httpVersion?: HttpVersion;
	/**
	 * Verify the TLS certificate. Sent on every execute for that reason and one more: the engine
	 * defaults to `true`, so an omitted `false` verifies a certificate the user turned verification
	 * off for, a security decision, not a surprise (#706).
	 */
	verifySSL?: boolean;
	/**
	 * The engine's default headers this send refuses, by name (#1229); see {@link RequestDefaults}
	 * for what it can name. Omitted, never `[]`, when it refuses none: that is the payload sent
	 * before the field existed. A malformed list (not an array, a non-string, a non-header name) is
	 * a `400`, since no later gate would notice a request the client will not get; a name the
	 * engine adds nothing under is accepted and inert, because config can switch a default off
	 * between a client reading the set and sending.
	 */
	disabledDefaultHeaders?: string[];
	/**
	 * The request's stored protocol settings (#1765), sent on **every** execute for the `verifySSL`
	 * reason. `disabledSystemHeaders` is the *stored* opt-out list, distinct from the per-send
	 * `disabledDefaultHeaders`; the engine unions the two.
	 */
	disableCookies?: boolean;
	disabledSystemHeaders?: string[];
	disableUrlEncoding?: boolean;
	requestId?: string;
	/**
	 * The request's name, read by scripts as `pm.info.requestName` (#300); never on the wire. Sent
	 * because Send executes *editor state*, which may be unsaved or a detached replay copy with a
	 * name no stored row has. `POST /compose` fills it on its by-id path (MCP's route) and
	 * `POST /execute` falls back to `requestId`'s row, so a caller linking only an id still gets
	 * one. Omitted, not empty: a script must read `undefined`, not `""`.
	 */
	requestName?: string;
	environmentId?: string;
	/**
	 * Run in full but record nothing: no run row, History entry, trace on disk or retention prune
	 * (#382). Absent means recorded, as every user send wants. The one caller is GraphQL schema
	 * introspection, a background fetch the user never made, which as a design run filled History,
	 * wrote resolved credentials into a trace and evicted real runs through the count-based prune.
	 * MCP's `run_request` does *not* set it: an agent's runs belong in History.
	 */
	transient?: boolean;
	/**
	 * Consume the response as `text/event-stream` instead of buffering it (#573). It changes the
	 * *execution model*: the endpoint answers `202` with {@link ExecuteStreamResponse}, not the
	 * exchange. Sent on **every** execute, never elided when false, by the redirect-policy rule and
	 * a sharper reason: the two answers have different shapes, so a caller letting an engine
	 * default decide would not know which it is about to parse. `stream` with `transient` is a
	 * `400` (a stream is its run row). Scripts run: the pre-request one before the transfer, the
	 * post-request one after the stream ends, reading `pm.response.events` (#575); their output is
	 * stored on the run's trace, since the `202` went long before.
	 */
	stream?: boolean;
	/**
	 * The JSONPath each event's JSON `data` is read through for the reply's text (#3773). An inline
	 * compose carries none, so a send states it here, beside `stream: true` only: the engine
	 * refuses a path on a buffered send, and one outside the JSONPath subset with a message naming
	 * the field. Absent reads no text.
	 */
	streamTextPath?: string;
	/**
	 * One data row bound before the request goes out (#601), the single-send half of
	 * `scenario.data`. `{{data.column}}` in the URL, headers, body, form fields and auth
	 * credentials binds against it, and both scripts read it as `pm.iterationData`
	 * (`pm.info.iteration` is 0: the send is row 0 of 1). Absent, those tokens go out as written
	 * and `pm.iterationData` is `undefined`. An object, not a run's array. A column the row lacks
	 * is a `400` naming the token and the row's columns, and nothing is sent, as a run refuses per
	 * iteration. Credentials bind **before** encoding (#642), so basic auth base64s the row's
	 * values, as a collection run does per iteration (#591). OAuth 2.0 is unreachable by a row (its
	 * token comes from the token endpoint), so `{{data.*}}` in an oauth2 config is a `400` naming
	 * the token.
	 */
	data?: Record<string, unknown>;
	/**
	 * Who started the run (#1817). `apiService` stamps `{kind: "app"}` on every execute and run
	 * start, so a caller never sets it; declared because the payload is the wire's shape.
	 */
	origin?: RunOrigin;
	/**
	 * Whether the answer's `body` carries a parsed copy of a JSON response (#2544). The engine
	 * defaults to `true`; `false` answers `body: null` and skips the tree, which for a large body
	 * is a whole copy on the daemon's heap. `bodyRaw` is unaffected. `apiService.executeRequest`
	 * always sends `false` (the pane is built from `bodyRaw`, `paneBody`, and nothing reads
	 * `body`); the MCP server leaves it unset, as its `run_request` shows the agent `body`.
	 */
	includeParsedBody?: boolean;
}

export type ExecuteRequestResponse = SanityResult;

/**
 * `POST /execute`'s answer for a streaming request: `202` at once, with the run row and its events
 * URL; the transfer has only just reached the consumer worker, so there is no exchange. `eventsUrl`
 * (`/runs/:id/events`) is used **as given**, never rebuilt from `runId`: a second spelling in
 * `api-endpoints.ts` could disagree with the engine. An answer missing either field fails loudly.
 */
export interface ExecuteStreamResponse {
	runId: string;
	eventsUrl: string;
	status: string;
}

/**
 * The `POST /compose` body (#226). The engine owns composition: it resolves `{{variables}}` (the
 * app's precedence) and `inherit` auth (walking the chain) into the payload `POST /execute` /
 * `POST /runs` accept unchanged. Pure (nothing sent, no run row), and the execution endpoints never
 * interpolate, so a payload is resolved exactly once. `requestId` composes the stored request;
 * `request` is an inline unresolved one (editor state, maybe unsaved or a replay copy); given both,
 * the inline fields lay over the stored ones. `collectionId` scopes an inline request's chain (a
 * stored request's own collection wins).
 */
export interface ComposeRequestRequest {
	requestId?: string;
	request?: Record<string, unknown>;
	collectionId?: string;
	environmentId?: string;
	/**
	 * Bare column names a data row will bind after this composition (#1007), names only. Postman
	 * binds columns to bare names, so an import writes `{{username}}` where Vayu writes
	 * `{{data.username}}`. Composition runs once and a row binds per iteration, so these names stay
	 * written for the bind, *above* the environment: a same-named variable here would send the
	 * value the row replaces. Absent means no dataset. Sent only by a caller that will bind a row
	 * (`POST /execute` with `data`, `POST /runs` with a data set), never as "the columns the
	 * collection declares". A non-array, or an entry that is not a non-empty string, is a `400`.
	 */
	dataColumns?: string[];
	/**
	 * Leave the `{{$guid}}` family (every `dynamic_variable_names()` token) written instead of
	 * resolving it now (#995). A load run repeats the composed payload per iteration and virtual
	 * user, so resolving here would send one generated value every time. Set only by a caller
	 * starting a run from the result (`POST /runs`); a Send composes and sends once, so it resolves
	 * the family here. Absent or `false` resolves as usual; a non-boolean is a `400`.
	 */
	deferDynamicVariables?: boolean;
}

/**
 * `POST /compose`'s answer: an `ExecuteRequestRequest` plus fields that rode through verbatim (the
 * resolved `elements` a load run renames to `requestElements`; scripts are never interpolated).
 *
 * - `deferredVariables` (#2521): names a pre-request script runs before, left as `{{name}}` because
 *   it may replace them. Sorted; absent when none. Display only: `useEngine` strips it before
 *   `/execute` or `/runs`.
 * - `collectionId` (#3461): the leaf of the chain composition read, absent when none. Part of the
 *   send: `/execute` and `/runs` read the scripts' collection scope from it when no `requestId` row
 *   names one, so a spread of the answer carries it.
 * - `stream`: on a by-id compose only, the saved row's Event stream setting (#3561); a caller
 *   spreading that answer into `/execute` states its own, or a streaming row answers
 *   `202 {runId, eventsUrl}`.
 */
export type ComposedRequest = ExecuteRequestRequest &
	Record<string, unknown> & {
		collectionId?: string;
		deferredVariables?: string[];
	};

/**
 * The single-request `POST /runs` body: the HTTP request's fields at the root, a `mode`, and that
 * mode's parameters.
 */
export interface StartLoadTestRequest {
	method: string;
	url: string;
	// Resolved, enabled-only: ordered lines or the single-valued record, as `/execute` takes them.
	headers?: HeaderLine[] | Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;

	// Redirect policy, as `/execute` takes it, so a load test runs under the user's policy.
	followRedirects?: boolean;
	maxRedirects?: number;

	/** The composed request's own timeout - see {@link ExecuteRequestRequest.timeout}. */
	timeout?: number;

	/** Protocol to negotiate - same rationale as `followRedirects` above. */
	httpVersion?: HttpVersion;

	/** TLS verification - same rationale, and see {@link Request.verifySSL}. */
	verifySSL?: boolean;

	/**
	 * The engine's default headers this run refuses (#1229), on the rules and omit-when-empty
	 * contract of {@link ExecuteRequestRequest.disabledDefaultHeaders}: a load run must send Send's
	 * header set, or it measures a different request.
	 */
	disabledDefaultHeaders?: string[];

	/** Always sent (#1765); see {@link ExecuteRequestRequest.disableCookies}. */
	disableCookies?: boolean;
	disabledSystemHeaders?: string[];
	disableUrlEncoding?: boolean;

	// Load test strategy
	mode: LoadTestMode;

	// Duration-bounded modes: constant_rps, constant_concurrency, ramp_up, capacity
	duration?: string; // e.g., "10s", "2m"
	// constant_rps only: the engine refuses a positive rate on any other mode (#2396)
	targetRps?: number;

	// For "iterations" mode
	iterations?: number;
	concurrency?: number;

	// For "ramp_up" mode
	rampUpDuration?: string;
	startConcurrency?: number;

	// For "capacity" mode: `startConcurrency` is where the search begins and `concurrency` the
	// ceiling it never passes, the ramp's fields reused; `duration` is the whole search's deadline.
	/** p99 budget the search looks for the edge of, in ms. */
	sloMs?: number;
	/** How long each concurrency level is held before it is judged, e.g. `"5s"`. */
	stepDuration?: string;

	// Optional linking
	requestId?: string;
	environmentId?: string;
	comment?: string;

	// Generator backpressure
	maxInFlight?: number; // Max concurrent in-flight requests before drops/queue. Default per-strategy.

	// Data capture options
	// A sampling period, not a percentage: the engine keeps a trace when
	// `counter % success_sample_rate == 0`, so 1 keeps every response and 100 keeps 1%. 0 would
	// divide by zero, so the engine 400s it. Build it with `successSamplePeriod`, which converts
	// the UI's percentage.
	success_sample_rate?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	/**
	 * Hold a virtual user for a 429's or 503's `Retry-After` (capped by `retryAfterMaxMs`) before
	 * its next request, so the run does not hammer a limiter (#3782). Off by default: a run that
	 * backs off measures the rate the limiter allows. Closed-loop modes only; `constant_rps` skips
	 * it with a warning.
	 */
	retryAfterBackoff?: boolean;
	/** The longest one wait, 1-3600000 ms; the engine defaults it to 30000. */
	retryAfterMaxMs?: number;
	/**
	 * This run's step-level elements (#1594): the chain root to leaf, then the request's own, the
	 * list {@link ExecuteRequestRequest.elements} carries and `POST /compose` echoes. A key apart
	 * from `elements` because the payload is flat, so one key cannot be both the array and the
	 * run-level override. `POST /runs` refuses `tests`, `postRequestScript(s)` and
	 * `preRequestScript(s)` by name.
	 */
	requestElements?: ResolvedElement[];
	/**
	 * The `elements` run override (#1594): `scripts` picks whether a `script.*` element in
	 * {@link requestElements} runs inline on the event-loop worker or stays deferred to the
	 * post-run replay. Also accepted (and validated) beside a `scenario` block, since the validator
	 * does not tell the shapes apart; see {@link StartScenarioRunRequest.elements} for `timers`,
	 * which this dialog has no control for.
	 */
	elements?: { scripts?: "asMarked" | "allInline" | "allDeferred" };

	// Pass/fail budgets for the whole run, camelCase as the engine's own metric names, which return
	// unchanged in the report's `thresholdValidation`. Omitted when none: the engine refuses an
	// empty object rather than start an unjudged run.
	thresholds?: RunThresholds;

	/**
	 * The `thresholds` keys carried over rather than set for this run (#2195). The engine stores
	 * it, the report echoes it as `metadata.configuration.carriedBudgets`, and it never changes the
	 * verdict. Omitted when none.
	 */
	carriedBudgets?: string[];

	// The server-vitals endpoint scraped during the run, camelCase like `thresholds`. Omitted when
	// no endpoint was given: the engine refuses a block with no `series`.
	monitor?: RunMonitorConfig;

	/**
	 * Consume each transfer as `text/event-stream` (#576), with `POST /execute`'s flag and cap
	 * names: the engine reads both endpoints through one parser. Sent from the request's own
	 * `stream`, never from the load dialog: streaming is the request's property; only the bounds
	 * below are the run's.
	 */
	stream?: boolean;
	/** See {@link ExecuteRequestRequest.streamTextPath}; read off the request, like `stream`. */
	streamTextPath?: string;
	/**
	 * The literal the run's streams are timed to (#3774), read off the request like `stream`. A
	 * Send carries none: it checks the field and times nothing with it. Absent means no marker.
	 */
	streamFirstContentMarker?: string;
	/**
	 * Wall-clock ceiling on one stream, ms; omitted takes `sseMaxStreamDurationMs`. Under load a
	 * stream is bounded by construction (the loop refills concurrency per completion, so an endless
	 * transfer leaks its slot for the rest of the run), and reaching a cap is a **successful**
	 * completion, not a timeout.
	 */
	maxStreamDurationMs?: number;
	/** Ceiling on events delivered by one stream; omitted takes `sseMaxStreamEvents`. */
	maxStreamEvents?: number;

	/**
	 * The data set this run binds, one object per row (#993): `scenario.data`'s single-request
	 * spelling, read by the same validator and bounded by `maxScenarioDataRows` /
	 * `maxScenarioDataBytes`; an empty array is refused. **One row per submission**, from a
	 * run-wide cursor that wraps, so a run longer than the set repeats it. A scenario run's row is
	 * per iteration and shared by every step instead, so the fields are separate and sending both
	 * is a `400`. Every `{{data.column}}` in the URL, headers, body and auth binds per submission,
	 * and a deferred `script.post` reads its sample's row as `pm.iterationData`. The set is never
	 * persisted (the snapshot records its row count, file name and hash), but a bound cell travels
	 * in its request, which the run stores with its retained traces.
	 */
	data?: Record<string, unknown>[];
	/** The rows' file (#2051): a display name, never a path; refused without `data`. */
	dataFileName?: string;
	/** That file's SHA-256, 64 lowercase hex, to tell two runs' files apart. Only beside `data`. */
	dataFileHash?: string;
	/** Numbers read as numbers (#2540); the engine only records it. Only beside `data`. */
	dataFileCastNumbers?: boolean;
	/**
	 * Who started it (#1817), stamped by `apiService`; see {@link ExecuteRequestRequest.origin}.
	 */
	origin?: RunOrigin;
}

export interface StartLoadTestResponse {
	runId: string;
	status: string;
	message?: string;
}

/**
 * The other `POST /runs` shape: an ordered collection instead of a single request, so no
 * `method`/`url` and no `mode`, and `iterations` inside the block. The engine resolves the plan
 * before answering, so every rejection (empty collection, a step that will not compose, a plan over
 * `maxScenarioSteps`) is a `400` with no run row. The answer is a load run's `202 {runId}`: the
 * lifecycle is a load run's, only the executor differs. A load `mode` beside the block makes a
 * **scenario load run** (#357): the same plan driven by `concurrency` virtual users on the event
 * loop. No `mode` means design mode, so an older payload keeps its meaning.
 */
export interface StartScenarioRunRequest {
	/**
	 * Load mode, for a scenario *load* run; omit for a design-mode run. `constant_rps` is a `400`,
	 * not a silent downgrade: an open-loop rate over a multi-step sequence is an arrival-rate
	 * executor, which Vayu lacks. So is any non-zero `rps`/`targetRps`: a scenario run is
	 * closed-loop by design.
	 */
	mode?: "constant_concurrency" | "ramp_up" | "iterations";
	/** Wall-clock length, e.g. `"60s"`. Read by the two duration-bounded modes. */
	duration?: string;
	/**
	 * The number of **virtual users**, as k6 and JMeter mean it. Each walks the plan alone, with
	 * its own cookies; in-flight requests are bounded by this count, so `maxInFlight` is moot.
	 */
	concurrency?: number;
	/** `ramp_up` only: the virtual-user count the ramp starts from. */
	startConcurrency?: number;
	/** `ramp_up` only: how long the ramp takes, e.g. `"10s"`. */
	rampUpDuration?: string;
	/**
	 * `mode: "iterations"` only: total passes over the plan across all virtual users. Not
	 * `scenario.iterations`, the design runner's per-run pass count; a load run reads this one.
	 */
	iterations?: number;
	/**
	 * Run-level stream caps (#3235), ms, for a collection run with a `stream` request. They bound
	 * each such step and are accepted **without** `stream`; a non-streaming step ignores them, and
	 * an omitted one falls back to its `sse*` setting. Never send `stream` on a scenario run: it is
	 * a `400`, since the flag belongs to each stored request.
	 */
	maxStreamDurationMs?: number;
	maxStreamEvents?: number;
	/**
	 * Scenario load run only: hold a virtual user for a 429's or 503's `Retry-After` (capped by
	 * `retryAfterMaxMs`) before its next step (#3782, #3799). **Omitted when off**: absent means
	 * off, and the cap is sent only with it.
	 */
	retryAfterBackoff?: boolean;
	/** The longest one wait, 1-3600000 ms; the engine defaults it to 30000. */
	retryAfterMaxMs?: number;
	scenario: {
		/**
		 * Discriminator for a future stored scenario. `"collection"` is the only accepted value; an
		 * unknown one is a 400, never a fall-through to the collection path.
		 */
		source: "collection";
		collectionId: string;
		/**
		 * Descend into sub-collections depth-first, each subtree before its parent's own requests
		 * (the sidebar's order). Default false.
		 */
		recursive?: boolean;
		/**
		 * Passes over the plan, a whole number, 1 or more. Default 1, or the row count when `data`
		 * is present and this absent. Omit it rather than send the row count: the engine owns that
		 * rule (`parse_scenario_request`), and a client's copy would be a second one.
		 */
		iterations?: number;
		/**
		 * The data set, one object per row, driving `{{data.column}}` and `pm.iterationData`
		 * (#402). Inline because the engine never opens a file: the sandbox has no filesystem, and
		 * a user path would be a new trust boundary. The app parses CSV/TSV/JSON/JSONL
		 * (`services/data-files`); the engine bounds the rows by `maxScenarioDataRows` and
		 * `maxScenarioDataBytes` and refuses an empty array. The row *set* is never persisted (the
		 * snapshot records its count, file name and hash), but a cell bound into a request is
		 * stored with it in the step trace (#731).
		 */
		data?: Record<string, unknown>[];
		/** The rows' file (#2051): a display name, never a path; refused without `data`. */
		dataFileName?: string;
		/** SHA-256 of that file's bytes, 64 lowercase hex. Only beside `data`. */
		dataFileHash?: string;
		/** Numbers read as numbers (#2540); the engine only records it. Only beside `data`. */
		dataFileCastNumbers?: boolean;
	};
	/** What `{{variables}}` resolve against, and whose cookie jar the run uses. */
	environmentId?: string;
	/**
	 * Make the collection's OpenAPI contract a gate: a step that passed all else but whose response
	 * does not match the bound document's schema is **failed** (#720). Top-level, where the engine
	 * reads it (`read_fail_on_schema_error`). **Omitted when off**, unlike `followRedirects`: the
	 * engine defaults to `false`, and a snapshot carrying the key only when on reads the same as
	 * one written before it existed. Design-mode runs only: the load executor validates at run end
	 * and never demotes a step.
	 */
	failOnSchemaError?: boolean;
	/**
	 * End a collection run's iteration at every `errored` step, script errors and transport
	 * failures included (#2526). Off (the default), an errored step is reported and the iteration
	 * moves on, as Postman and Newman do; the runner's own refusals end the iteration either way.
	 * Top-level and **omitted when off**, as `failOnSchemaError`. Design-mode runs only; a scenario
	 * load run ignores it.
	 */
	stopOnError?: boolean;
	/**
	 * Overrides the element pipeline across every step without editing the collection (#1495).
	 * Top-level, where the engine reads it for both `POST /runs` shapes
	 * (`validate_elements_run_override`, `engine/src/core/load_strategy.cpp`); every key is
	 * optional, and an unknown key or value is a `400` naming the field. `timers` applies to a
	 * design-mode run too; `scripts` and `includeScriptTime` only to a scenario load run, since a
	 * sequential run has no inline/deferred split.
	 */
	elements?: {
		/**
		 * `"asConfigured"` (default): each `timer.*` runs its stored config. `"off"`: every one is
		 * silenced. `{fixedMs}` / `{minMs, maxMs}` (#1498): each one's wait is replaced by the same
		 * value or uniform range, "replaced, not merged" as `scripts` is. No app control sends the
		 * object shapes (`RunCollectionDialog`'s Timers toggle is `asConfigured` | `off`); the
		 * engine accepts them for MCP or a future control.
		 */
		timers?: "asConfigured" | "off" | { fixedMs: number } | { minMs?: number; maxMs?: number };
		/**
		 * `"asMarked"` (default) reads each `script.*` element's `config.inline`; `"allInline"` /
		 * `"allDeferred"` force every one of the run's `script.*` elements one way. `extract.*` and
		 * `assert.*` always run inline on a scenario load run.
		 */
		scripts?: "asMarked" | "allInline" | "allDeferred";
		/** Adds pipeline time to step and run latency when `true`; default: transfer only. */
		includeScriptTime?: boolean;
	};
	/**
	 * Pass/fail budgets the run is judged against (#1497 for a load run, #1564 for a design-mode
	 * collection run). Top-level, where the engine reads it (`validate_thresholds`,
	 * `evaluate_thresholds`) for both shapes. Omit to measure the run without judging it.
	 */
	thresholds?: RunThresholds;
	/**
	 * Who started it (#1817), stamped by `apiService`; see {@link ExecuteRequestRequest.origin}.
	 */
	origin?: RunOrigin;
}

// Run Management API
export interface ListRunsParams {
	request_id?: string;
	type?: "load" | "sanity";
	status?: string;
	limit?: number;
	offset?: number;
}

export interface ListRunsResponse {
	runs: Run[];
	total: number;
}

export interface GetRunResponse {
	run: Run;
}

export type GetRunReportResponse = RunReport;

/**
 * `DELETE /runs`' verdict. `deletedIds` is what a client closes tabs for; `deleted` is its length.
 * `keptPinned` counts baselines still stored; a run kept for being in flight is in neither count.
 */
export interface ClearRunsResponse {
	deleted: number;
	keptPinned: number;
	deletedIds: string[];
}

export interface StopRunResponse {
	runId: string;
	status: string;
	message?: string;
	summary?: {
		totalRequests: number;
		errors: number;
		errorRate: number;
		avgLatency: number;
	};
}

// Cookie jar API (issue #301)

/**
 * One cookie the engine holds, as `GET /cookies` reports it. `CookiesCard` reads every field: name
 * and value are the row, domain and path say which requests it rides on, `secure` / `httpOnly` are
 * badges, and `expires` (0 for a session cookie) tells "until you close Vayu" from a date.
 */
export interface EngineCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	/** Unix seconds, or 0 for a session cookie. */
	expires: number;
}

/** One jar. `environmentId` is null for sends with no environment, never "", so it is no id. */
export interface CookieScope {
	environmentId: string | null;
	cookies: EngineCookie[];
}

export interface GetCookiesResponse {
	scopes: CookieScope[];
}

export interface ClearCookiesResponse {
	cleared: number;
}

// Client-certificate registry (issue #707)

/**
 * What the certificate file holds (#833): `pem` keeps the key in a second file; `p12` is a PKCS#12
 * bundle with both. Every platform reads both (#851); the engine stores which, because libcurl must
 * be told (`CURLOPT_SSLCERTTYPE`) or it hands a bundle to its PEM parser.
 */
export type ClientCertificateFormat = "pem" | "p12";

/**
 * A registry entry, as `GET /client-certificates` reports it. No passphrase: the engine never
 * echoes it (write-only), so `hasPassphrase` is all the card renders; echoing it would put a secret
 * in every screenshot of Settings.
 */
export interface ClientCertificate {
	id: string;
	/**
	 * Lower-cased hostname, no scheme or port (as stored), or the one wildcard form
	 * `*.example.com`, which answers every subdomain and never the domain itself (#803).
	 */
	host: string;
	/** The port this entry is specific to, or null when it answers on every one. */
	port: number | null;
	certPath: string;
	/** `""` for a `p12` entry, which carries its own key and stores no path. */
	keyPath: string;
	certFormat: ClientCertificateFormat;
	hasPassphrase: boolean;
	createdAt: number;
	updatedAt: number;
}

/**
 * A row as `GET /client-certificates` lists it: the entry plus whether the engine would present it,
 * judged against the files now (#3260). Only the list judges (a create or update refuses an
 * unusable row and answers a bare `ClientCertificate`), so never patch either result into a list
 * cache as if it said `usable`.
 */
export interface ClientCertificateListEntry extends ClientCertificate {
	/** `false` if the file moved or the format was edited around the routes: never sent. */
	usable: boolean;
	/** Why the entry is not presented; present only when `usable` is `false`. */
	problem?: string;
}

/**
 * A create or update body. `port: null` means every port; on an update `passphrase: null` clears a
 * stored one, the engine's null-vs-absent rule, hence nullable rather than optional.
 */
export interface ClientCertificateInput {
	host: string;
	port: number | null;
	certPath: string;
	/**
	 * Absent lets the engine read the format off the file, as a caller with no opinion should. A
	 * named one is checked against those bytes, so a wrong value is a `400`, not a handshake
	 * failure later.
	 */
	certFormat?: ClientCertificateFormat;
	/** `null` clears a stored path - how an entry moves from `pem` to `p12`. */
	keyPath: string | null;
	passphrase?: string | null;
}

// Transport diagnostics (issue #708)

/**
 * Which hop answered, and how. Coarser than the engine's `ErrorCode` on purpose: the reader picks
 * which setting to point at, and these are the outcomes that lead somewhere different. Anything
 * else is `failed`, with the engine's message, not a fourth word implying a fourth remedy.
 */
export type ConnectionTestOutcome = "ok" | "proxy_failed" | "tls_failed" | "timed_out" | "failed";

/**
 * What `POST /diagnostics/connection` answers. No response body, ever: this is diagnostics, not a
 * fetch proxy (that is `/import/fetch`, behind its own byte bound).
 */
export interface ConnectionTestResult {
	url: string;
	outcome: ConnectionTestOutcome;
	/** The proxy the test actually went through. */
	proxy: {
		/** The `proxyMode` in force - `environment`, `system`, `manual` or `off`. */
		mode: string;
		/** The proxy, `user:pass@` stripped by the engine so safe to show; absent when direct. */
		url?: string;
		/**
		 * `"environment"` when Vayu did not configure the proxy (`environment` mode, or `system`
		 * with nothing resolved) and libcurl read `http_proxy` / `https_proxy` / `all_proxy` itself
		 * and sent the probe through one. `url` is then what it read, absent only if unreadable.
		 * Absent when `url` is the setting in force or the probe went direct.
		 */
		source?: "environment";
	};
	/**
	 * The registry entry the probe offered; `""` when none matched or the URL is `http://`, where
	 * none is presented (#3260). "Offered": the handshake may have refused it (see `outcome`).
	 */
	clientCertificate: string;
	/** The status line, present only on `ok`. */
	status?: number;
	/** The engine's `ErrorCode` spelling, absent on `ok`. */
	errorCode?: string;
	/** libcurl's own message, absent on `ok`. */
	detail?: string;
}

// Workspace backup (issue #987)

/**
 * What `POST /workspace/backup` answers. `path` is the point: restoring is a file copy the user
 * does with the engine stopped, so where the snapshot went is what they need. There is no restore
 * call: a live engine overwriting its own open database is the footgun the feature avoids.
 */
export interface WorkspaceBackupResult {
	/** Absolute path of the snapshot written. */
	path: string;
	/** Size on disk; a compacted copy, so smaller than the live database. */
	sizeBytes: number;
	/** When it was taken, in Unix ms. */
	createdAt: number;
	/** How many older snapshots `maxBackupsRetained` removed in the same call. */
	pruned: number;
}

// Trash (issue #988)

/**
 * One deleted root, as `GET /trash` lists it. **Roots only:** deleting a collection stamps its
 * subtree in one transaction, and the engine lists the row the user deleted, not every row that
 * went with it. A request is a root only while its collection is live, an example only while its
 * request is.
 *
 * A collection's `purgeCollections` and `purgeRequests` are what a **purge** destroys: every
 * deleted row under the root, an *earlier* delete's included, which the list does not show (#3449);
 * a purge prompt and the row read them. The engine also sends the **cohort** pair `collections` /
 * `requests` (what that one delete took, which a restore puts back, never above the purge totals);
 * this type does not claim it because nothing reads it. Add it with its reader.
 *
 * An environment (#2970) is always a root and takes nothing with it: its variables are on its row,
 * counted in `variables`. A saved example (#2971) and a client certificate (#2973) take nothing
 * either; a certificate's `name` is its target, `host` or `host:port`.
 */
export interface TrashEntry {
	id: string;
	kind: "collection" | "request" | "environment" | "example" | "clientCertificate";
	name: string;
	/** When it was deleted, Unix ms; the stamp the retention purge reads. */
	deletedAt: number;
	/*
	 * The engine also sends `parentId` (the collection's old parent, the request's collection, the
	 * example's request, null for an environment or certificate); this type does not claim it, as
	 * `RequestExample` omits fields it does not use. A row names its owner through `parentName`,
	 * which the engine resolves, because the id would need a live tree that may not hold a deleted
	 * parent. Add `parentId` with its reader. The wire shape is in
	 * `docs/engine/api-reference/trash.md`.
	 */
	/**
	 * The live owner's name (a request's collection, an example's request). Request and example
	 * entries only, so two same-named entries tell apart (#3449).
	 */
	parentName?: string;
	/** Sub-collections a purge destroys, an earlier delete's included (#3449). Always 0 for every kind but a collection. */
	purgeCollections: number;
	/** Requests a purge destroys, an earlier delete's included (#3449). Always 0 for every kind but a collection. */
	purgeRequests: number;
	/** How many variables the environment holds. Sent on environment entries only. */
	variables?: number;
}

export interface ListTrashResponse {
	items: TrashEntry[];
	total: number;
}

/**
 * What `POST /trash/{id}/restore` answers: the entry as listed, plus what the restore did.
 * `reparentedToRoot` is the one thing a caller cannot infer: a collection whose parent is gone or
 * trashed returns as a tree root, which moves it, and the user must be told. A *request* there is
 * refused (409 naming the Trash root to restore first), since a request has no root to land on.
 */
export interface RestoreTrashResponse extends TrashEntry {
	restored: true;
	reparentedToRoot: boolean;
}

/** What `DELETE /trash/{id}` answers with - the entry it destroyed. */
export interface PurgeTrashResponse extends TrashEntry {
	purged: true;
}

// Webhook inbox API (#480). An inbox is engine-hosted listener state, so nothing here is stored
// client-side; the surface reads it back.

/** What an inbox answers every caller with. */
export interface InboxCannedResponse {
	status: number;
	body: string;
	headers: Record<string, string>;
	delayMs: number;
}

export interface Inbox {
	inboxId: string;
	/**
	 * What a webhook source is pointed at: `http://<bind>:<port>/`, except for a wildcard bind
	 * (`0.0.0.0`, `::`), where it is the first non-loopback IPv4 address, since a sender cannot use
	 * the wildcard (#3114).
	 */
	url: string;
	/** Each non-loopback IPv4 address as an inbox URL; wildcard binds only (may be empty). */
	reachableAt?: string[];
	bind: string;
	port: number;
	/** False once stopped; the record and its captures stay readable. */
	running: boolean;
	/** False when the inbox is reachable beyond this machine - badge it. */
	loopback: boolean;
	/**
	 * Captures held, i.e. what deleting the inbox destroys. Up to one services poll old, so a
	 * surface holding the capture list knows better (`capturesAtRisk` in
	 * `modules/inbox/useInboxDeletion.ts`).
	 */
	captureCount: number;
	/**
	 * Pages granted credentialed CORS (#2367), canonical spelling. Empty is the default: every
	 * origin may read the canned answer, none with the user's cookies. Fixed for the inbox's life.
	 */
	allowedOrigins: string[];
	response: InboxCannedResponse;
}

/** One request an inbox recorded. */
export interface InboxCapture {
	id: number;
	inboxId: string;
	receivedAt: number;
	method: string;
	/** Raw path as received, percent-escapes kept, without the query. */
	path: string;
	/** Raw query string, without the `?`. */
	query: string;
	headers: Record<string, string>;
	/** At most the per-capture cap (`bodyTruncated`); UTF-8, or base64 under `"base64"`. */
	body: string;
	/**
	 * `"base64"` when the stored bytes are not valid UTF-8 (protobuf, image, gzip), so `body`
	 * spells bytes, not text to show. Truncated base64 is still whole base64, of the prefix.
	 */
	bodyEncoding: "utf8" | "base64";
	/**
	 * Size as received: above the stored body when truncated, and for base64 not `body`'s length.
	 */
	bodyBytes: number;
	bodyTruncated: boolean;
	remoteAddr: string;
}

export interface StartInboxRequest {
	port?: number;
	bind?: string;
	/** Required by the engine for any bind that is not loopback. */
	confirmNonLoopback?: boolean;
	/** At most 32 `scheme://host[:port]` origins; absent or empty is the any-origin default. */
	allowedOrigins?: string[];
	response?: Partial<InboxCannedResponse>;
}

export interface ListInboxesResponse {
	data: Inbox[];
}

/** The `{data, pagination}` envelope `GET /inbox/:id/requests` returns. */
export interface InboxCapturesResponse {
	data: InboxCapture[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
}

export interface ClearInboxCapturesResponse {
	inboxId: string;
	cleared: number;
}

/** What `DELETE /inbox/:id` reports it destroyed - record plus captures. */
export interface DeleteInboxResponse {
	inboxId: string;
	capturesDeleted: number;
}

// OAuth 2.0 mock issuer API (#479). Engine-process state like an inbox: each issuer has its own
// loopback listener and a restart forgets them all, so nothing is stored client-side.

/**
 * How the issuer misbehaves, to test retry, error and discovery handling. The first three affect
 * `/token`; each other one breaks one route (the RFC 8414 document, `/register`, the authorize
 * redirect's `iss`).
 */
export type MockIssuerFailureMode =
	| "none"
	| "slow"
	| "server_error"
	| "invalid_client"
	| "metadata_not_found"
	| "registration_refused"
	| "wrong_iss";

/** One running issuer, as `GET /mock-issuer` and the `PUT` reply describe it. */
export interface MockIssuer {
	issuerId: string;
	/** Base URL - the OAuth `iss` of every token it mints. */
	issuerUrl: string;
	tokenUrl: string;
	authorizeUrl: string;
	/** RFC 8414 authorization server metadata. */
	metadataUrl: string;
	/** For a config's discovery field: a protected resource whose 401 leads to the metadata. */
	discoverUrl: string;
	/** HS256 secret the service under test verifies this issuer's tokens with. */
	signingKey: string;
	port: number;
	expiresInSeconds: number;
	failureMode: MockIssuerFailureMode;
	/** How long `slow` mode waits before answering; ignored in every other mode. */
	slowMs: number;
	issueRefreshTokens: boolean;
	/** Scope `/resource` requires of a token; empty requires none. */
	resourceScope: string;
	/** 0 accepts any client id; otherwise the id must be one of the configured ones. */
	clientCount: number;
	createdAt: number;
}

export interface MockIssuerClient {
	clientId: string;
	clientSecret?: string;
}

export interface StartMockIssuerRequest {
	/** 0 (the default) binds an ephemeral port. */
	port?: number;
	expiresInSeconds?: number;
	claims?: Record<string, unknown>;
	clients?: MockIssuerClient[];
	failureMode?: MockIssuerFailureMode;
	slowMs?: number;
	issueRefreshTokens?: boolean;
	/** Space-separated scope tokens `/resource` requires; fixed once started. */
	resourceScope?: string;
}

/**
 * The start call answers URLs and the key only; the list carries the settings, so starting one
 * invalidates the list rather than writing the reply into the cache.
 */
export interface StartMockIssuerResponse {
	issuerId: string;
	issuerUrl: string;
	tokenUrl: string;
	authorizeUrl: string;
	metadataUrl: string;
	discoverUrl: string;
	signingKey: string;
}

export interface ListMockIssuersResponse {
	issuers: MockIssuer[];
}

/** Only these three can change under a bound listener; the rest are a 400. */
export interface UpdateMockIssuerRequest {
	expiresInSeconds?: number;
	failureMode?: MockIssuerFailureMode;
	slowMs?: number;
}

export interface StopMockIssuerResponse {
	stopped: boolean;
}

// Collection mock server API (#481 phase 2). Engine-process state like an inbox or issuer: each
// mock serves the collection's saved examples on its own loopback listener; a restart forgets all.

/** One running mock server, as `POST /mock/start` and `GET /mock` describe it. */
export interface MockServer {
	mockId: string;
	collectionId: string;
	/** Named at start time; the collection may have been renamed since. */
	collectionName: string;
	/** `http://127.0.0.1:<port>`, with no trailing slash: a base to point at. */
	url: string;
	port: number;
	latencyMs: number;
	errorRatePct: number;
	/** Requests in the collection subtree the mock is serving. */
	routeCount: number;
	/** Routes with no saved example, which answer 501: what explains an empty-looking mock. */
	routesWithoutExample: number;
	/**
	 * Requests that never answer: another request shares their method and path (#3115). Absent from
	 * older engines.
	 */
	duplicateRoutes?: number;
	createdAt: number;
	/**
	 * Pages granted credentialed CORS (#2367), canonical spelling. Empty is the default: every
	 * origin may read the mock, none with the user's cookies. Fixed for the mock's life.
	 */
	allowedOrigins: string[];
}

export interface StartMockServerRequest {
	collectionId: string;
	/** 0 (the default) binds an ephemeral port. */
	port?: number;
	/** Artificial delay before every answer, 0-30000. */
	latencyMs?: number;
	/** Share of answers replaced by a synthesized 500, 0-100. */
	errorRatePct?: number;
	/** At most 32 `scheme://host[:port]` origins; absent or empty is the any-origin default. */
	allowedOrigins?: string[];
}

export interface ListMockServersResponse {
	data: MockServer[];
}

export interface StopMockServerResponse {
	mockId: string;
	stopped: boolean;
}

/** One entry of a mock's route table, as `GET /mock/:id/routes` reports it. */
export interface MockServerRoute {
	requestId: string;
	requestName: string;
	method: string;
	/** The normalized template, e.g. `/pets/{{petId}}`. */
	path: string;
	hasExample: boolean;
	/** The example's status, or 0 when there is no example to serve. */
	status: number;
	/** See {@link import("./domain").MockResponseMode}. */
	mode: import("./domain").MockResponseMode;
	/** The example that would answer for `"first"`/`"fixed"` - absent for `"random"`. */
	exampleName?: string;
	/** How many times this route has answered a request, since the mock started. */
	hits: number;
	/**
	 * Only when another request with this method and path answers for both (#3115); never `false`.
	 */
	shadowed?: true;
	/** The request that answers in this row's place; present exactly when `shadowed` is. */
	shadowedBy?: { requestId: string; requestName: string };
}

export interface ListMockServerRoutesResponse {
	data: MockServerRoute[];
}

/** One entry of a mock's activity log, as `GET /mock/:id/activity` reports it. */
export interface MockActivityEntry {
	/** Epoch milliseconds. */
	at: number;
	method: string;
	path: string;
	requestId: string | null;
	requestName: string | null;
	exampleId: string | null;
	exampleName: string | null;
	status: number;
	injectedError: boolean;
}

export interface ListMockServerActivityResponse {
	data: MockActivityEntry[];
}

// Health & Config API
export type GetHealthResponse = EngineHealth;

export interface GetConfigResponse {
	entries: import("./domain").ConfigEntry[];
	success?: boolean;
}

export interface UpdateConfigRequest {
	// Single entry update
	key?: string;
	value?: string;
	// Bulk update
	entries?: Record<string, string>;
}

/**
 * Which send `GET /request-defaults` answers for (#1338). They can differ: `negotiateCompression`
 * governs a design send's `Accept-Encoding` and `loadNegotiateCompression` a load run's. `"design"`
 * is the Headers tab's answer (what sending now adds); `"load"` is what a load run adds instead.
 */
export type RequestDefaultsScope = "design" | "load";

/**
 * A header the engine adds to a request that does not name it (#1229). Declared by the engine over
 * `GET /request-defaults`, not derived here from config: a client's copy would be a second
 * definition of the rule, which is how the renderer and the engine came to disagree.
 */
export interface RequestDefaultHeader {
	/** The header name as it goes on the wire. */
	name: string;
	/** Absent when `generated` - there is no value until a send makes one. */
	value?: string;
	/** A fresh value per transfer, so no two sends carry the same one. */
	generated: boolean;
	/** The engine config key governing it; absent for one that is always on. */
	configKey?: string;
}

/** What `GET /request-defaults` answers: what a send would add, right now. */
export interface RequestDefaults {
	headers: RequestDefaultHeader[];
}

// Import API

/**
 * Marks a `POST /import/fetch` as a `$ref` a document asked for, not a URL a person typed (#2364).
 * With `reference` the engine follows no redirect and refuses a loopback or link-local peer other
 * than `sourceUrl`'s own host and port; without `sourceUrl` it refuses every such peer.
 */
export interface ImportFetchOptions {
	reference?: boolean;
	/** The URL of the document the reference was found in. */
	sourceUrl?: string;
}

export interface ImportFetchResponse {
	content: string;
	contentType: string;
}

/**
 * How much of a URL import has arrived (#882). `total` is the upstream's `Content-Length`, **null
 * when it declared none** (a chunked response); the dialog then draws bytes received, not a
 * percentage.
 */
export interface ImportFetchProgress {
	received: number;
	total: number | null;
}

/**
 * `POST /import/apply`: the whole parsed import in one atomic call. Items reference each other by
 * opaque `tempId`s that never reach the database; the engine assigns every id (refusing one sent)
 * and returns the translation in `idMap`. Names and defaults otherwise match the `Create*Request`,
 * because the engine runs the same per-resource field appliers.
 */
export interface ImportApplyCollection {
	tempId: string;
	parentTempId?: string | null;
	name: string;
	description?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	/**
	 * Typed behaviours (#1512), carried verbatim from the parsed draft so a `script.pre` /
	 * `script.post` element lands on the created row instead of being dropped; `preRequestScript` /
	 * `postRequestScript` are refused (#1514). The Elements tab edits them afterwards (#1516).
	 */
	elements?: unknown[];
	/**
	 * The spec document this collection binds, by the payload's temp id (#637). `specTempId`, not
	 * `specId`: the document is created by the same call, so the engine resolves the temp id and
	 * stores the real one; `specTempId` is never persisted.
	 */
	openapi?: { specTempId: string };
	/** The collection's data contract, when the source states one (a Vayu export does). */
	dataSchema?: CollectionDataSchema;
}

/**
 * An OpenAPI document riding along with its import (#637). A section of its own, not a field on the
 * collection, because several collections may bind one spec: it gets a temp id, appears in `idMap`,
 * and {@link ImportApplyCollection.openapi} references it.
 */
export interface ImportApplySpec {
	tempId: string;
	content: string;
	/** Absent when the document did not come from a URL (a file or a paste). */
	sourceUrl?: string;
	/**
	 * Neither index is sent: the engine derives the declared operations (#853) and response schemas
	 * (#860) from the stored document, as it computes the hash.
	 */
}

/**
 * A saved example on an import's request item (#481). No `tempId`: nothing references an example,
 * so the engine assigns its id and it never reaches `idMap`. Array order is stored order.
 */
export interface ImportApplyExample {
	name: string;
	status?: number;
	headers?: KeyValueEntry[];
	body?: string;
	contentType?: string;
}

export interface ImportApplyRequestItem {
	tempId: string;
	collectionTempId: string;
	name: string;
	description?: string;
	method: string;
	url: string;
	params?: KeyValueEntry[];
	headers?: KeyValueEntry[];
	body?: RequestBody;
	bodyType?: string;
	auth?: RequestAuth;
	/** See {@link ImportApplyCollection.elements}. */
	elements?: unknown[];
	/** Omitted unless the imported file states them; the engine then applies its own defaults. */
	followRedirects?: boolean;
	maxRedirects?: number;
	/** Omitted unless the imported file states one - see {@link Request.timeout}. */
	timeout?: number;
	verifySSL?: boolean;
	httpVersion?: HttpVersion;
	stream?: boolean;
	/** Omitted unless the imported file states them (Postman's `protocolProfileBehavior`). */
	disableCookies?: boolean;
	disabledSystemHeaders?: string[];
	disableUrlEncoding?: boolean;
	/**
	 * Postman's `protocolProfileBehavior`, verbatim - see
	 * {@link Request.postmanProtocolBehavior}. A string is the engine parse's
	 * form (JSON text in source member order), forwarded as it came.
	 */
	postmanProtocolBehavior?: string | Record<string, unknown> | null;
	order?: number;
	/** Omitted unless the source file carried saved responses for this request. */
	examples?: ImportApplyExample[];
	/** Omitted unless the source was a spec that named this request's operation. */
	specOperation?: SpecOperation;
	/** Omitted unless the source states which saved example a mock answers with. */
	mockResponseMode?: MockResponseMode;
	/**
	 * The `"fixed"` target, by index in this item's `examples`: those rows have no id yet (#1649).
	 */
	mockExampleIndex?: number;
}

export interface ImportApplyEnvironment {
	tempId: string;
	name: string;
	description?: string;
	variables?: Record<string, VariableValue>;
}

/**
 * A registry candidate a Postman import resolved (#1656), with `POST /client-certificates`' field
 * names, because `POST /import/apply` reuses that route's check-and-write, best-effort, after the
 * tree commits. No `tempId`: nothing references a certificate, and the engine owns its id.
 */
export interface ImportApplyClientCertificate {
	host: string;
	port?: number;
	certPath: string;
	keyPath?: string;
	certFormat?: "pem" | "p12";
	passphrase?: string;
}

/**
 * `POST /import/parse` (#877): a raw import document in, the whole `ImportResult` out. `fileName`,
 * `sourceUrl` and `unresolvedRefs` are what no parser can read from the bytes: the file's name,
 * where it came from (a relative `servers[0].url` resolves against it, and a spec is stored with
 * it), and how many external `$ref`s bundling could not reach.
 */
export interface ImportParseRequest {
	/** The document's text, verbatim. */
	content: string;
	/** Both default to `true` engine-side; the dialog sends its toggles. */
	importEnvironments?: boolean;
	importScripts?: boolean;
	fileName?: string;
	sourceUrl?: string;
	unresolvedRefs?: number;
}

/**
 * `POST /import/mcp` (#3838): the engine asks a live MCP server what it offers and answers the
 * `POST /import/parse` tree. `headers` ride every call; `auth` is written as an `Authorization`
 * header unless `headers` names one. `include` defaults engine-side to tools only, and one that
 * leaves nothing included is a 400.
 */
export interface ImportMcpRequest {
	url: string;
	headers?: { name: string; value: string }[];
	auth?: { mode: "bearer"; token: string };
	include?: { tools?: boolean; resources?: boolean; prompts?: boolean };
}

/** What one entry of an MCP listing is, as `POST /import/mcp/diff` names it (#3842). */
export type ImportMcpDiffKind = "tool" | "resource" | "prompt";

/** A listed entry no stored request claims. `name` is what an import would call the request. */
export interface ImportMcpDiffAdded {
	kind: ImportMcpDiffKind;
	key: string;
	name: string;
}

/** A stored request whose key the server no longer lists. */
export interface ImportMcpDiffRemoved extends ImportMcpDiffAdded {
	requestId: string;
}

/**
 * A stored request the server still lists, with the fields that differ. `key` is the listing's and
 * `name` the stored request's; `renamedFrom` is the key the request had when the listing renamed
 * it, and `fields` may then be empty.
 */
export interface ImportMcpDiffChanged extends ImportMcpDiffRemoved {
	fields: ("description" | "inputSchema" | "outputSchema")[];
	renamedFrom?: string;
}

/** One root collection whose `mcpBaseUrl` is the request's `url`, compared with the server now. */
export interface ImportMcpDiffMatch {
	collectionId: string;
	name: string;
	identical: boolean;
	added: ImportMcpDiffAdded[];
	removed: ImportMcpDiffRemoved[];
	changed: ImportMcpDiffChanged[];
}

/**
 * `POST /import/mcp/diff` (#3842): the body of `POST /import/mcp` in, what importing that server
 * again would change about each collection an earlier import of it built. `matches` is `[]` when
 * no collection holds the URL, which is not an error.
 */
export interface ImportMcpDiffResponse {
	matches: ImportMcpDiffMatch[];
}

/**
 * What `POST /import/mcp/apply` writes (#3994): each list names rows of the diff the caller was
 * shown. `added` entries are the diff's `{kind, key}`; `changed` and `removed` are stored request ids.
 */
export interface ImportMcpApplySelect {
	added: { kind: ImportMcpDiffKind; key: string }[];
	changed: string[];
	removed: string[];
}

/** `POST /import/mcp/apply`: the body of `POST /import/mcp`, the collection compared and the rows chosen. */
export interface ImportMcpApplyRequest extends ImportMcpRequest {
	collectionId: string;
	select: ImportMcpApplySelect;
}

/** What an apply wrote: the requests it created, the ones it updated in place, the ones it deleted. */
export interface ImportMcpApplyResponse {
	collectionId: string;
	created: { kind: ImportMcpDiffKind; key: string; requestId: string }[];
	updated: string[];
	deleted: string[];
}

export interface ImportApplyRequest {
	collections: ImportApplyCollection[];
	requests: ImportApplyRequestItem[];
	environments: ImportApplyEnvironment[];
	/**
	 * Spec documents this payload creates. Always sent, `[]` included: absent also reads as none,
	 * but stating it keeps one payload shape for every format.
	 */
	specs: ImportApplySpec[];
	/**
	 * Registry candidates a Postman import resolved (#1656). Always sent, `[]` included, by
	 * {@link specs}' one-shape rule; only a Postman preview fills it.
	 */
	clientCertificates: ImportApplyClientCertificate[];
}

export interface ImportApplyResponse {
	/** Every `tempId` sent, mapped to the engine-generated id it became. */
	idMap: Record<string, string>;
}

// Specs API (#637). Create-only and read by id: a changed document is a different document, so
// there is no PUT; a re-fetch stores a new one and moves the binding.

/** A stored OpenAPI document as the engine hands it back. */
export interface SpecDocument {
	id: string;
	content: string;
	/** `null` - not `""` - when the document did not come from a URL. */
	sourceUrl: string | null;
	fetchedAt: number;
	/** Hex sha256, computed engine-side on every write. */
	hash: string;
	/**
	 * The declared-operation index stored beside the document (#629). `null`, not `[]`, when stored
	 * before the index existed or by a client sending none, so "never extractable" differs from
	 * "declares nothing".
	 */
	operations: DeclaredOperation[] | null;
	/** The response schema index (#628); `null` on `operations`' terms. */
	responseSchemas: ResponseSchemaIndex | null;
}

/**
 * A stored document described rather than transferred (#712): `GET /specs/:id/meta` gives the Spec
 * tab's card a source, date and size without the up-to-`maxSpecDocumentBytes` document (12 MB for
 * Stripe's spec) riding along on every tab open. Its fields are the document's own; `content`,
 * `operations` and `responseSchemas` are **absent**, not empty, so "not read here" is not "has
 * none".
 */
export interface SpecDocumentMeta {
	id: string;
	/** `null` - not `""` - when the document did not come from a URL. */
	sourceUrl: string | null;
	fetchedAt: number;
	/** Hex sha256, computed engine-side on every write. */
	hash: string;
	/** The document's size in bytes - the unit `maxSpecDocumentBytes` caps. */
	contentBytes: number;
}

export interface CreateSpecRequest {
	/** Engine-assigned - see CreateCollectionRequest.id. */
	id?: never;
	content: string;
	sourceUrl?: string | null;
	/**
	 * Neither index is a field: the engine derives the declared operations (#629, moved by #853)
	 * and response schemas (#628, moved by #860) from the stored document, as it computes the hash.
	 * Sending either is a `400`.
	 */
}

// Spec sync (#655): `POST /specs/sync` applies a re-fetched document to its bound collection,
// storing it, moving the binding and creating, updating and deleting the chosen operations in one
// transaction. Not `/import/apply`, which only creates; see engine/src/http/routes/spec_sync.cpp.

/** A tag collection an added operation needs and the collection lacks. */
export interface SpecSyncCollection {
	tempId: string;
	name: string;
	/** Absent means the collection being synced; anything else must be beneath it. */
	parentId?: string;
	description?: string;
}

/**
 * An added operation, as the request it becomes. No `examples`: a sync writes the responses its
 * stored document declares (#869), so a created request's examples come from that document; sending
 * them is a `400`.
 */
export type SpecSyncCreate = Omit<ImportApplyRequestItem, "collectionTempId" | "examples"> & {
	/** The stored collection it lands in - or `collectionTempId`, never both. */
	collectionId?: string;
	collectionTempId?: string;
};

/**
 * A merge-patch on one stored request: only the fields the user takes from the document, plus the
 * identity when the document moved it. `examples` is a decision (#869): `true` refreshes the
 * request's imported examples from the stored document (examples saved from live responses, and
 * statuses the user deleted, are untouched); absent leaves all alone. The engine reads the rows off
 * the document, so a payload cannot state an example the document does not describe.
 */
export interface SpecSyncUpdate {
	id: string;
	name?: string;
	description?: string;
	method?: string;
	url?: string;
	params?: KeyValueEntry[];
	headers?: KeyValueEntry[];
	body?: RequestBody;
	bodyType?: string;
	specOperation?: SpecOperation;
	examples?: boolean;
}

/**
 * What `POST /specs/match` is asked (#761): a collection and the operations a document declares. No
 * requests: the engine walks the subtree itself, because an OpenAPI import binds the root and files
 * requests under tag sub-collections, so "the collection's requests" would miss most.
 */
export interface SpecMatchRequest {
	collectionId: string;
	/**
	 * The identities the document declares, relayed from `POST /specs/describe` rather than
	 * extracted by the caller (#869): the engine's answer is what the bind derives from the same
	 * bytes, so a preview and its write cannot pair requests differently.
	 */
	operations: SpecOperation[];
	/**
	 * The path parts of the document's server URLs, relayed from `POST /specs/describe` (#3030). A
	 * literal-URL request carries the base path (`https://h/v1/pets`) where the document writes
	 * `/pets`, and the bind derives base paths from the document, so a preview without them would
	 * show fewer matches than the bind stamps.
	 */
	basePaths?: string[];
}

/** A picked document, for `POST /specs/describe` (issue #869). */
export interface SpecDescribeRequest {
	/** The document's text, verbatim. */
	content: string;
}

/**
 * What the engine says a picked document is (#869): what the Spec tab's card shows before a bind,
 * from the bind's own reader. A document that is not a contract or cannot be read is a `400` saying
 * which, never an answer declaring nothing.
 */
export interface SpecDescribeResponse {
	/** `"OpenAPI 3.0"`, `"OpenAPI 3.1"` or `"OpenAPI 2.0 (Swagger)"`. */
	format: string;
	/** `info.title`, and `""` for a document that states none. */
	title: string;
	/** Every operation it declares, in document order. */
	operations: SpecOperation[];
	/**
	 * Each server URL's path, `[]` if none (#3030); `POST /specs/match` takes it with `operations`.
	 */
	basePaths: string[];
}

export interface SpecMatchResponse {
	/** The requests that resolved to exactly one operation, and it to them. */
	matched: { requestId: string; operation: SpecOperation }[];
	/** Request ids left over - no operation, or an ambiguous shape. */
	unmatchedRequests: string[];
	/** Unclaimed operations: a sync creates requests for them (#627), a bind never does. */
	unmatchedOperations: SpecOperation[];
}

/**
 * What `POST /specs/bind` is asked (#862): a collection and a document. **No pairing is sent:** a
 * bind writes identity, and a caller's pairing would be a second opinion on what the document
 * declares, so the engine matches the subtree against the index it derives from the bytes it
 * stores, and stamps the result. `SpecMatchRequest` previews the same rule over the same walk. No
 * `clear` list either: clearing what matched the *previous* document is the other half of the same
 * walk, and a list is what #718 was, one a caller could forget.
 */
export interface SpecBindRequest {
	collectionId: string;
	/** The document. `hash`, `fetchedAt` and both indexes are engine-computed. */
	spec: {
		content: string;
		sourceUrl?: string | null;
	};
}

export interface SpecBindResponse {
	/** The stored document the collection is now bound to. */
	specId: string;
	specHash: string;
	syncedAt: number;
	/** Requests that matched an operation and now carry its identity. */
	stamped: number;
	/** Requests whose identity was *removed*, unclaimed by this document (#718); re-binds only. */
	cleared: number;
	/** Request ids left over - no operation, or an ambiguous shape. */
	unmatchedRequests: string[];
	/** Operations no request claimed. A bind creates nothing for them. */
	unmatchedOperations: SpecOperation[];
}

// Spec diff (#854): `POST /specs/diff` answers what a re-fetched document would change about its
// bound collection, and writes nothing (applying is `POST /specs/sync`). It is engine-side (#761
// phase B) so an agent can reach it and #853's reader stays the one "what does this produce".

/**
 * What `POST /specs/diff` is asked: a bound collection and the document to compare. Neither the
 * requests nor the *bound* document are sent: the engine walks the subtree (an import files
 * requests under tag sub-collections) and reads the bound document from the binding, since the
 * three-way user-touched rule only works if the "previous" side is the bytes stored.
 */
export interface SpecDiffRequest {
	collectionId: string;
	/** The re-fetched document, verbatim. */
	spec: { content: string };
}

/**
 * The request an import would build for one operation: the values behind every
 * `SpecFieldDiff.next`, and what an apply writes. `next` is truncated for display, so the apply
 * reads this, not the report: one draft, compared and then written.
 */
export interface SpecDraftRequest {
	name: string;
	description: string;
	method: string;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	/**
	 * The operation's documented responses (#481). Not compared (the `origin="import"` replaced,
	 * `origin="user"` kept rule only matters at apply), but carried because applying refreshes the
	 * request's imported examples from them.
	 */
	examples: SpecDraftExample[];
}

/**
 * One documented response, as the engine derives it: the import parsers' `ExampleDraft`, in full
 * rather than as `ImportApplyExample`, since every field is on the wire here while the import's are
 * optional for formats stating no status or media type.
 */
export interface SpecDraftExample {
	/** `"200 - A user"` with a description, `"200"` without. */
	name: string;
	status: number;
	/** `Content-Type`, or empty when the response documents no payload. */
	headers: KeyValueEntry[];
	body: string;
	contentType: string;
}

/**
 * The fields an OpenAPI import writes that a sync may claim. `auth` and the elements are absent on
 * purpose: an import reads them (`security`, `x-vayu-elements`), but a sync never compares them, so
 * a re-fetched document cannot overwrite what the user edited (`read_import_only_members`).
 */
export type SpecField = "name" | "description" | "method" | "url" | "params" | "headers" | "body";

/** One field of one request that no longer matches the document. */
export interface SpecFieldDiff {
	field: SpecField;
	/** What the request holds today, rendered for display. */
	current: string;
	/** What the re-fetched document produces, rendered for display. */
	next: string;
	/**
	 * The request's value is neither the new document's nor the bound one's: somebody edited it.
	 * False whenever `previousUnknown` is set, since with no bound value that claim cannot be made.
	 */
	userTouched: boolean;
}

/** An operation no request claims. It becomes a request only if the user ticks it. */
export interface SpecDiffAdded {
	operation: SpecOperation;
	/** The sub-collection an import would file it under, `""` for the root. */
	folder: string;
	draft: SpecDraftRequest;
	/**
	 * A sync with no ticks creates this; {@link SpecDiffChanged.safe} says why the engine judges.
	 */
	safe: boolean;
}

/**
 * An operation no request claims because a person deleted its request (#3031). Shaped like
 * {@link SpecDiffAdded}, since ticking one is the same create, but never in `added`: nothing
 * pre-ticks it, and `safe` is always `false`.
 */
export interface SpecDiffDeclined extends SpecDiffAdded {
	safe: false;
}

/** A request whose recorded operation the new document no longer declares. */
export interface SpecDiffRemoved {
	requestId: string;
	name: string;
	operation: SpecOperation;
	/**
	 * A sync with no ticks deletes this: always `false`, as deleting is opt-in. Carried for
	 * {@link SpecDiffChanged.safe}'s reason.
	 */
	safe: boolean;
}

/** A request whose operation is still declared but no longer produces it. */
export interface SpecDiffChanged {
	requestId: string;
	name: string;
	/** The identity the request carries today. */
	boundOperation: SpecOperation;
	/** The same operation as the new document declares it. */
	operation: SpecOperation;
	/** How the request was followed from its recorded identity into the document. */
	matchedBy: "operationId" | "path";
	/** The document moved the identity itself - the other half of it changed. */
	renamed: boolean;
	/** Not in the bound document, so user edits cannot be told apart from document changes. */
	previousUnknown: boolean;
	/** Every field that no longer matches, in display order. Empty for a pure rename. */
	fields: SpecFieldDiff[];
	draft: SpecDraftRequest;
	/**
	 * A sync with no ticks updates this request at all (#871). The engine's answer, not this
	 * side's: its rules (never write a field somebody edited, never delete, leave an
	 * indistinguishable request alone) are the ones whose silent failure costs a person their work,
	 * so they have one author (`core::safe_spec_apply`), which `POST /specs/sync`'s
	 * `policy: "safe"` applies too. `defaultSelection` reads these marks instead of deriving them.
	 */
	safe: boolean;
	/**
	 * The fields such a sync writes; empty for a pure rename (a real selection) and for a request
	 * it leaves alone.
	 */
	safeFields: SpecField[];
}

export interface SpecDiffResponse {
	/** The document is byte for byte the stored one - there is nothing to apply. */
	identical: boolean;
	added: SpecDiffAdded[];
	/** Operations whose request the user deleted - listed apart, never ticked for them. */
	declined: SpecDiffDeclined[];
	removed: SpecDiffRemoved[];
	changed: SpecDiffChanged[];
	/** Requests whose operation is unchanged in every compared field. */
	unchanged: number;
	/**
	 * Requests with no operation identity: not compared, but counted, because a sync silently
	 * ignoring half a collection is unreadable.
	 */
	unmapped: number;
}

/** The serializations `POST /specs/export` writes. */
export type ExportFormat = "json" | "yaml";

/**
 * What `POST /specs/export` is asked (#855): a collection and how to write it. Neither the requests
 * nor the bound document are sent: the engine gathers the subtree, its examples and the document,
 * as `SpecMatchRequest` does, and the export *patches* the document, so a renderer sending it back
 * would return bytes it already read a second opinion out of.
 */
export interface SpecExportRequest {
	collectionId: string;
	/** Defaults to `json` engine-side. */
	format?: ExportFormat;
	/** What a bound export may write. Defaults to `contract`; a skeleton ignores it. */
	mode?: ExportMode;
}

/**
 * What a bound export may write into its document, the export dialog's choice. `contract` keeps it
 * the API's contract (examples and parameter values only); `full` writes every edit the collection
 * holds, new operations included, in the document's dialect.
 */
export type ExportMode = "contract" | "full";

/**
 * What the export could not carry, and what it changed, all shown before download. Zero is a
 * statement too ("0 requests with no operation" is how a bound export says it carried everything),
 * so every field is present.
 */
export interface ExportNotes {
	/** `document` updated the bound spec; `skeleton` described a free-form collection. */
	direction: "document" | "skeleton";
	/** What the exported document declares itself to be - `OpenAPI 3.0.3`, `Swagger 2.0`. */
	dialect: string;
	requestsExported: number;
	requestsWithoutOperation: number;
	operationsNotInDocument: number;
	operationsRemoved: number;
	requestsWithoutPath: number;
	duplicateOperations: number;
	examplesWritten: number;
	examplesWithoutMediaType: number;
	examplesTruncated: number;
	examplesAlreadyDeclared: number;
	examplesSampledAtImport: number;
	sharedParametersLeft: number;
	referencedResponsesLeft: number;
	bodiesNotWritten: number;
	rowsNotDeclared: number;
	operationsEdited: number;
	/** A Swagger 2.0 document: operations are removed, nothing is written in. */
	vocabularyNotWritten: boolean;
	/**
	 * Credential values written as `""`: auth tokens, passwords, API-key and client-secret values,
	 * secret variables, and by name the header, query-parameter and URL-password values and a saved
	 * example's response headers, each counted once wherever written. A pure `{{variable}}` is
	 * kept; bodies and scripts are never judged. A `contract` export counts too, at the parameter a
	 * withheld row would have filled.
	 */
	secretsOmitted: number;
	/**
	 * Requests only `x-vayu-collection` carries (no path, or a method and path another request
	 * claimed). Vayu re-imports them; other tools do not see them.
	 */
	requestsOnlyInExtension: number;
	/** Operations a `full` bound export added for requests the document never declared. */
	operationsAdded: number;
	/** Which bound mode ran; `""` for a skeleton. */
	boundMode: ExportMode | "";
}

export interface SpecExportResponse {
	/** The document, serialized in the requested format. */
	text: string;
	/** What a download should be called. */
	fileName: string;
	notes: ExportNotes;
}

/**
 * What `POST /export/postman` is asked: a collection and whether its credentials travel. Only the
 * id, as `SpecExportRequest`: the engine reads the subtree, variables and auth itself.
 */
export interface PostmanExportRequest {
	collectionId: string;
	/**
	 * Write credentials as stored. Default `false` engine-side: auth secrets, secret variables and
	 * the credentials in headers, parameters, URLs, saved examples and cookie values are written
	 * empty and counted in `PostmanExportNotes.secretsOmitted`. `true` is what Postman's own export
	 * does.
	 */
	includeSecrets?: boolean;
}

/** One kind of thing the Postman document has no place for, and how often it came up. */
export interface PostmanNotCarried {
	/** Stable identifier for the kind, e.g. a load-test setting or an element type. */
	code: string;
	count: number;
	/** The engine's sentence, shown as written. */
	message: string;
}

/**
 * What a Postman export wrote and could not. `notCarried` is open-ended: the engine names each loss
 * in its own words, so a new kind reaches the dialog without a field here.
 */
export interface PostmanExportNotes {
	requestsExported: number;
	foldersExported: number;
	/**
	 * Credential values written as `""`: auth secrets, secret variables, and by name the header,
	 * parameter and URL values, a saved example's recorded request and response headers, and every
	 * cookie value. Zero under `includeSecrets`. Bodies are never judged.
	 */
	secretsOmitted: number;
	notCarried: PostmanNotCarried[];
}

export interface PostmanExportResponse {
	/** The Postman Collection v2.1 document, as JSON text. */
	text: string;
	/** `<name>.postman_collection.json`. */
	fileName: string;
	notes: PostmanExportNotes;
}

/**
 * What `POST /export/postman-environment` is asked: an environment and whether its secret values
 * travel. Only the id; the engine reads the variables.
 */
export interface PostmanEnvironmentExportRequest {
	environmentId: string;
	/**
	 * Write secret values as stored. Default `false` engine-side: a secret variable keeps its row
	 * and name, its value is written `""` and counted in
	 * `PostmanEnvironmentExportNotes.secretsOmitted`.
	 */
	includeSecrets?: boolean;
}

/**
 * What a Postman environment export wrote and could not; `notCarried` is open-ended, as
 * `PostmanExportNotes`'.
 */
export interface PostmanEnvironmentExportNotes {
	variablesExported: number;
	/** Secret values written as `""`. Zero when `includeSecrets` was set. */
	secretsOmitted: number;
	/**
	 * One `variable_types` entry per untyped write: a `json` type (as `default`), a typed secret's
	 * (as `secret`).
	 */
	notCarried: PostmanNotCarried[];
}

export interface PostmanEnvironmentExportResponse {
	/** The Postman environment document, as JSON text. */
	text: string;
	/** `<name>.postman_environment.json`. */
	fileName: string;
	notes: PostmanEnvironmentExportNotes;
}

/**
 * `POST /export/run-report`'s formats: `json`, `markdown` (#2131), `html` (#2135, charts inline).
 */
export type RunReportExportFormat = "json" | "markdown" | "html";

/** What `POST /export/run-report` is asked: a finished load run, and how to write it. */
export interface RunReportExportRequest {
	runId: string;
	/** Defaults to `json` engine-side. */
	format?: RunReportExportFormat;
	/** `full` (the default) carries every tick of the time series; `none` leaves it out. */
	series?: "full" | "none";
	/** A second finished load run; fills the document's `comparison`, `null` without it. */
	baseRunId?: string;
}

export interface RunReportExportNotes {
	/**
	 * Values the URL lost to `redact_url_credentials`: a `user:pass@` password, each
	 * credential-named query or fragment value.
	 */
	urlCredentialsOmitted: number;
}

export interface RunReportExportResponse {
	/** The document (`docs/engine/run-export.schema.json`), as text in the requested format. */
	text: string;
	/** `<title> <UTC start, YYYY-MM-DD HHmm>.run.json`, made safe for a file system. */
	fileName: string;
	/** `application/json` for `json`; what `downloadTextFile` is handed. */
	mimeType: string;
	notes: RunReportExportNotes;
}

export interface SpecSyncRequest {
	/** The bound collection. Nothing outside its subtree is written. */
	collectionId: string;
	/** The re-fetched document. `hash` and `fetchedAt` are engine-computed. */
	spec: {
		content: string;
		sourceUrl?: string | null;
		/**
		 * Neither index is carried: a sync writes a *new* `spec_documents` row and the engine
		 * derives both from it (#853, #860), so a sync cannot forget them and silently turn
		 * coverage or validation off.
		 */
	};
	collections: SpecSyncCollection[];
	create: SpecSyncCreate[];
	update: SpecSyncUpdate[];
	/** Request ids; one already deleted is the asked-for state, not an error. */
	delete: string[];
}

export interface SpecSyncResponse {
	/** Every `tempId` sent, mapped to the engine-generated id it became. */
	idMap: Record<string, string>;
	/** The stored document the collection is now bound to. */
	specId: string;
	specHash: string;
	syncedAt: number;
	created: number;
	updated: number;
	deleted: number;
}
