/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// API Request/Response Types

import type {
	Collection,
	Request,
	Environment,
	Run,
	SanityResult,
	RunReport,
	EngineHealth,
	VariableValue,
	KeyValueEntry,
	RequestBody,
	RequestAuth,
	OAuth2Config,
	LoadTestMode,
	ScriptPart,
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
	 * Never sent: the engine assigns every id and rejects a create that carries
	 * one with a 400 (#97). Declared as `never` rather than omitted so a literal
	 * with an `id` is a type error at the call site, not a runtime 400 - and
	 * `apiService.createCollection` strips it anyway, for the spread-through
	 * cases the type system cannot see.
	 */
	id?: never;
	name: string;
	description?: string;
	parentId?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	preRequestScript?: string;
	postRequestScript?: string;
}

export interface UpdateCollectionRequest {
	id: string;
	name?: string;
	description?: string;
	/**
	 * `string | null`, not `string`: the engine reads absent as "keep the current
	 * parent" and an explicit JSON `null` as "move to the root", so a move out of
	 * a folder is only expressible as a null that survives to the wire.
	 */
	parentId?: string | null;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	preRequestScript?: string;
	postRequestScript?: string;
}

// Requests API
export interface ListRequestsParams {
	collectionId?: string;
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
	preRequestScript?: string;
	postRequestScript?: string;
	followRedirects?: boolean;
	maxRedirects?: number;
	httpVersion?: HttpVersion;
	order?: number;
}

export interface UpdateRequestRequest {
	id: string;
	/**
	 * The collection this request should belong to - a cross-collection move.
	 * The engine 400s an id that resolves to no collection rather than stranding
	 * the row, and a move that states no `order` appends in the destination.
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
	preRequestScript?: string;
	postRequestScript?: string;
	followRedirects?: boolean;
	maxRedirects?: number;
	httpVersion?: HttpVersion;
	order?: number;
}

// Reorder API (POST /reorder)

/**
 * One row's new position in a batch reorder, and - when it changes owner - its
 * new owner.
 *
 * `parentId` / `collectionId` follow the same merge-patch rule the single-row
 * `PUT`s use: omitted keeps the current owner, present states a move. Unlike
 * those, an owner that resolves to no stored collection is a `400` rather than
 * a tolerated forward reference, because nothing here is bulk-created.
 */
export type ReorderMove =
	| { type: "collection"; id: string; order: number; parentId?: string | null }
	| { type: "request"; id: string; order: number; collectionId?: string };

/**
 * A scope whose children are renumbered dense `0..n-1` in display order before
 * the moves apply. `parentId: null` is the root collections, and is stated
 * rather than omitted - the engine rejects an absent `parentId` so a renumber
 * can never land on a scope the caller did not mean.
 */
export type ReorderNormalize =
	| { type: "collection"; parentId: string | null }
	| { type: "request"; collectionId: string };

export interface ReorderRequest {
	moves: ReorderMove[];
	normalize: ReorderNormalize[];
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
	description?: string; // engine accepts this (environments.cpp); was missing from the TS type
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
	// Engine execution endpoint expects flat headers (resolved, enabled-only)
	headers?: Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;
	preRequestScripts?: ScriptPart[];
	postRequestScripts?: ScriptPart[];
	/**
	 * Redirect policy. Omitted means the engine's own defaults apply (follow,
	 * cap at 10) - send them explicitly so a request that opts out of following
	 * actually sees its 3xx in the response pane.
	 */
	followRedirects?: boolean;
	maxRedirects?: number;
	/**
	 * Protocol to negotiate. Sent on *every* execute, never elided when it
	 * equals the default - exactly like the redirect policy above, and for the
	 * same reason: an omitted field lets an engine-side default win silently,
	 * which is not a decision the client should hand over. Both engine clients
	 * (renderer and MCP) must agree on this; see CLAUDE.md's request-composition
	 * section.
	 */
	httpVersion?: HttpVersion;
	requestId?: string;
	/**
	 * The request's name, for the script sandbox to read as `pm.info.requestName`
	 * (issue #300). Not an HTTP field - it never reaches the wire.
	 *
	 * Sent by the client because Send executes *editor state*, which may be
	 * unsaved or a detached replay copy and therefore carries a name no stored
	 * row has. `POST /compose` fills it in on its by-id path (MCP's route), and
	 * `POST /execute` falls back to the row named by `requestId`, so a caller
	 * that only links an id still gets a name. Omitted rather than sent empty:
	 * a script must read `undefined`, not `""`.
	 */
	requestName?: string;
	environmentId?: string;
	/**
	 * Run the request in full but record nothing: no run row, no History entry,
	 * no result trace on disk, no retention prune (issue #382). Absent means
	 * recorded, which is what every user-initiated send wants.
	 *
	 * The one caller is GraphQL schema introspection - a background fetch the
	 * user never made, which as an ordinary design run filled History with runs
	 * nobody sent, wrote the resolved credentials into a trace on disk, and
	 * evicted real runs through the count-based retention prune. MCP's
	 * `run_request` deliberately does *not* set it: an agent's runs belong in
	 * History like anyone else's.
	 */
	transient?: boolean;
}

export type ExecuteRequestResponse = SanityResult;

/**
 * ComposeRequestRequest - the `POST /compose` body (issue #226).
 *
 * The engine owns request composition: it resolves `{{variables}}` (with the
 * app's precedence) and `inherit` auth (walking the collection chain), and
 * returns the execute-ready payload that `POST /execute` / `POST /runs`
 * accept unchanged. Pure - nothing is sent, no run row is created - and the
 * execution endpoints never interpolate, so a payload is resolved exactly
 * once.
 *
 * Two entry shapes, combinable: `requestId` composes the stored request;
 * `request` is an inline unresolved request (the renderer's editor state,
 * which may be unsaved or a detached replay copy) - given both, the inline
 * fields lay over the stored ones before resolution. `collectionId` scopes an
 * inline request's variable chain and inherit walk (a stored request's own
 * collection wins).
 */
export interface ComposeRequestRequest {
	requestId?: string;
	request?: Record<string, unknown>;
	collectionId?: string;
	environmentId?: string;
}

/**
 * What `POST /compose` returns: an `ExecuteRequestRequest` plus whatever
 * extra fields rode through composition verbatim (e.g. the load path's
 * `tests` script parts - scripts are never interpolated).
 */
export type ComposedRequest = ExecuteRequestRequest & Record<string, unknown>;

/**
 * StartLoadTestRequest - Matches POST /run backend endpoint
 * The backend expects a flat structure with:
 * - HTTP request fields (method, url, headers, body) at root level
 * - mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up"
 * - Mode-specific params (duration, targetRps, iterations, concurrency, etc.)
 */
export interface StartLoadTestRequest {
	method: string;
	url: string;
	// Engine load-test endpoint expects flat headers (resolved, enabled-only)
	headers?: Record<string, string>;
	body?: unknown;
	auth?: Record<string, unknown>;

	// Redirect policy - same fields the single-request endpoint takes, so a load
	// test exercises the request under the policy the user configured for it.
	followRedirects?: boolean;
	maxRedirects?: number;

	/** Protocol to negotiate - same rationale as `followRedirects` above. */
	httpVersion?: HttpVersion;

	// Load test strategy
	mode: LoadTestMode;

	// For constant_rps / constant_concurrency modes
	duration?: string; // e.g., "10s", "2m"
	targetRps?: number;

	// For "iterations" mode
	iterations?: number;
	concurrency?: number;

	// For "ramp_up" mode
	rampUpDuration?: string;
	startConcurrency?: number;

	// For "capacity" mode. `startConcurrency` is where the search begins and
	// `concurrency` is the ceiling it will not climb past - both fields the ramp
	// already owns, reused rather than respelled. `duration` is the whole
	// search's deadline.
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
	// Sampling period, not a percentage: the engine keeps a trace when
	// `counter % success_sample_rate == 0`, so 1 keeps every response and 100
	// keeps 1%. A 0 is a division by zero engine-side, and the engine rejects
	// it with a 400. Build it with `successSamplePeriod`, which converts from
	// the percentage the UI shows.
	success_sample_rate?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	tests?: ScriptPart[];

	// Pass/fail budgets for the whole run. camelCase because these are the
	// engine's own metric names, which come back unchanged in the report's
	// `thresholdValidation`. Omitted entirely when none were declared - the
	// engine rejects an empty object rather than starting an unjudged run.
	thresholds?: RunThresholds;

	// The server-vitals endpoint to scrape during the run. camelCase for the
	// same reason `thresholds` is - these are the engine's own field names.
	// Omitted entirely when no endpoint was given; the engine rejects a block
	// with no `series` rather than starting a run that scrapes nothing.
	monitor?: RunMonitorConfig;
}

export interface StartLoadTestResponse {
	runId: string;
	status: string;
	message?: string;
}

/**
 * StartScenarioRunRequest - the other shape `POST /runs` accepts.
 *
 * A scenario states its work as an ordered collection instead of a single
 * request, so it carries no `method`/`url` and no `mode`: the block replaces
 * them, and `iterations` lives inside it rather than beside a load-test mode.
 * The engine resolves the collection into a plan before answering, so every
 * rejection (empty collection, a step that will not compose, a plan over
 * `maxScenarioSteps`) is a `400` and no run row is created.
 *
 * The response is a load run's - `202 {runId}` - because the lifecycle is a
 * load run's; only the executor differs.
 *
 * Adding a load `mode` beside the block turns it into a **scenario load run**
 * (issue #357): the same plan, driven by `concurrency` virtual users on the
 * event loop rather than one sequence through the client. The absence of `mode`
 * is what still means design mode, so a payload written before load-mode
 * scenarios existed keeps its meaning exactly.
 */
export interface StartScenarioRunRequest {
	/**
	 * Load mode, for a scenario *load* run. Omit for a design-mode collection
	 * run.
	 *
	 * `constant_rps` is a `400` here, not a silent downgrade: an open-loop
	 * arrival rate over a multi-step sequence is an arrival-rate executor,
	 * which Vayu does not implement. So is any non-zero `rps`/`targetRps`,
	 * which is what would select that path regardless of the declared mode.
	 */
	mode?: "constant_concurrency" | "ramp_up" | "iterations";
	/** Wall-clock length, e.g. `"60s"`. Read by the two duration-bounded modes. */
	duration?: string;
	/**
	 * The number of **virtual users** - which is what `concurrency` means for a
	 * scenario, and what k6 and JMeter mean by it. Each walks the plan on its
	 * own, with its own cookies, and in-flight requests are bounded by this
	 * count by construction (so `maxInFlight` has nothing to do for this run).
	 */
	concurrency?: number;
	/** `ramp_up` only: the virtual-user count the ramp starts from. */
	startConcurrency?: number;
	/** `ramp_up` only: how long the ramp takes, e.g. `"10s"`. */
	rampUpDuration?: string;
	/**
	 * `mode: "iterations"` only: total passes over the plan across all virtual
	 * users. Distinct from `scenario.iterations`, which is the design-mode
	 * runner's per-run pass count - a load run reads this one.
	 */
	iterations?: number;
	scenario: {
		/**
		 * The discriminator for a future stored scenario. `"collection"` is the
		 * only value the engine accepts today, and an unknown one is a 400
		 * rather than a fall-through to the collection path.
		 */
		source: "collection";
		collectionId: string;
		/**
		 * Descend into sub-collections, depth-first, each subtree ahead of its
		 * parent's own requests - the order the sidebar shows. Default false.
		 */
		recursive?: boolean;
		/**
		 * Passes over the plan. Whole number, 1 or more.
		 *
		 * Default 1 - or, with `data` present and this absent, the row count.
		 * Omit it rather than sending the row count: the engine owns that rule
		 * (`parse_scenario_request`), and a client computing its own would be a
		 * second copy of it.
		 */
		iterations?: number;
		/**
		 * The data set, one object per row, driving `{{data.column}}` and
		 * `pm.iterationData` (issue #402).
		 *
		 * Inline on the payload because the engine never opens a file: the
		 * script sandbox has no filesystem access and a user-supplied path
		 * would be a new trust boundary. The app parses CSV/TSV/JSON/JSONL
		 * (`services/data-files`) and sends the rows; the engine bounds them
		 * with `maxScenarioDataRows` and `maxScenarioDataBytes` and rejects a
		 * present-but-empty array. Rows are never persisted on either side -
		 * the run snapshot records their count alone.
		 */
		data?: Record<string, unknown>[];
	};
	/** What `{{variables}}` resolve against, and whose cookie jar the run uses. */
	environmentId?: string;
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
 * One cookie the engine holds, as `GET /cookies` reports it.
 *
 * Every field has a reader in `CookiesCard`: the name and value are the row,
 * the domain and path say which requests it rides on, `secure` / `httpOnly`
 * are the badges, and `expires` (0 for a session cookie) distinguishes "until
 * you close vayu" from a date.
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

/**
 * One jar. `environmentId` is null for requests sent with no environment
 * selected - null rather than "" so it cannot be mistaken for an id.
 */
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

// Webhook inbox API (issue #480). An inbox is engine-hosted listener state, so
// none of these shapes is stored client-side - the surface reads them back.

/** What an inbox answers every caller with. */
export interface InboxCannedResponse {
	status: number;
	body: string;
	headers: Record<string, string>;
	delayMs: number;
}

export interface Inbox {
	inboxId: string;
	/** `http://<bind>:<port>/` - what a webhook source is pointed at. */
	url: string;
	bind: string;
	port: number;
	/** False once stopped; the record and its captures stay readable. */
	running: boolean;
	/** False when the inbox is reachable beyond this machine - badge it. */
	loopback: boolean;
	response: InboxCannedResponse;
}

/** One request an inbox recorded. */
export interface InboxCapture {
	id: number;
	inboxId: string;
	receivedAt: number;
	method: string;
	path: string;
	/** Raw query string, without the `?`. */
	query: string;
	headers: Record<string, string>;
	/** At most the engine's per-capture cap; see `bodyTruncated`. */
	body: string;
	/** Size as received, which is larger than `body.length` when truncated. */
	bodyBytes: number;
	bodyTruncated: boolean;
	remoteAddr: string;
}

export interface StartInboxRequest {
	port?: number;
	bind?: string;
	/** Required by the engine for any bind that is not loopback. */
	confirmNonLoopback?: boolean;
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

// Import API
export interface ImportFetchResponse {
	content: string;
	contentType: string;
}

/**
 * POST /import/apply - the whole parsed import in one atomic call.
 *
 * Items reference each other by opaque `tempId`s that never reach the database;
 * the engine assigns every real id and returns the translation in `idMap`. That
 * is why none of these shapes carries an `id` - the engine rejects one (it owns
 * ID generation for this path). Field names and defaults are otherwise identical
 * to the matching `Create*Request`, because the engine runs the same per-resource
 * field appliers for both.
 */
export interface ImportApplyCollection {
	tempId: string;
	parentTempId?: string | null;
	name: string;
	description?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
	auth?: Exclude<RequestAuth, { mode: "inherit" }>;
	preRequestScript?: string;
	postRequestScript?: string;
}

/**
 * A saved example response nested on an import's request item (issue #481).
 *
 * No `tempId`: an example is referenced by nothing, so the engine assigns its
 * id and it never appears in the response's `idMap`. Array order is the stored
 * order - the engine numbers them by payload index.
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
	preRequestScript?: string;
	postRequestScript?: string;
	/** Omitted unless the imported file states them; the engine then applies its own defaults. */
	followRedirects?: boolean;
	maxRedirects?: number;
	order?: number;
	/** Omitted unless the source file carried saved responses for this request. */
	examples?: ImportApplyExample[];
}

export interface ImportApplyEnvironment {
	tempId: string;
	name: string;
	description?: string;
	variables?: Record<string, VariableValue>;
}

export interface ImportApplyRequest {
	collections: ImportApplyCollection[];
	requests: ImportApplyRequestItem[];
	environments: ImportApplyEnvironment[];
}

export interface ImportApplyResponse {
	/** Every `tempId` sent, mapped to the engine-generated id it became. */
	idMap: Record<string, string>;
}
