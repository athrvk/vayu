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
	DeclaredOperation,
	ResponseSchemaIndex,
	SpecOperation,
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
	dataSchema?: CollectionDataSchema;
	/** The spec document to bind at create time - see {@link Collection.openapi}. */
	openapi?: CollectionOpenApiBinding;
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
	/**
	 * `CollectionDataSchema | null`, not just the object: the engine reads absent
	 * as "keep the declared contract" and an explicit JSON `null` as "reset to
	 * no contract", so **Clear** is only expressible as a null that survives to
	 * the wire - the same rule `parentId` above rides.
	 */
	dataSchema?: CollectionDataSchema | null;
	/**
	 * `CollectionOpenApiBinding | null`, for the same reason `dataSchema` above
	 * is: the engine reads absent as "keep the binding" and an explicit JSON
	 * `null` as "reset to unbound", so **Unbind** is only expressible as a null
	 * that survives to the wire. There is no unbind verb of its own.
	 */
	openapi?: CollectionOpenApiBinding | null;
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
	/** Verify the TLS certificate - see {@link Request.verifySSL}. */
	verifySSL?: boolean;
	/** Consume the response as an event stream - see {@link Request.stream}. */
	stream?: boolean;
	/** Which spec operation this request is - see {@link Request.specOperation}. */
	specOperation?: SpecOperation;
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
	/** Verify the TLS certificate - see {@link Request.verifySSL}. */
	verifySSL?: boolean;
	/** Consume the response as an event stream - see {@link Request.stream}. */
	stream?: boolean;
	/**
	 * `SpecOperation | null`, like the collection binding above: absent keeps the
	 * stored operation and an explicit `null` clears it, so stamping and
	 * un-stamping are the same verb.
	 */
	specOperation?: SpecOperation | null;
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

/**
 * One saved example, written from a live response (issue #588).
 *
 * `order` is deliberately not sendable: the engine appends when it is absent,
 * and appending is the contract this surface needs - a mock server answers with
 * the *first* example of a matched route, so a save must never change what a
 * restarted mock would serve.
 *
 * `origin` is a write-only field from the app's point of view. It is the
 * discriminator a spec sync reads (#627) to know which rows it may replace, so
 * everything saved here says `user` and nothing else in the app reads it back -
 * `RequestExample` does not claim it for that reason.
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
	 * Whether `body` stops short of the response it was captured from - the
	 * trace's `maxTraceBodyBytes` cap (issue #659).
	 *
	 * Required rather than optional: this is the only writer that can ever have
	 * a partial body, so leaving it off would be a claim by omission that the
	 * save is complete.
	 */
	bodyTruncated: boolean;
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
	/**
	 * Verify the TLS certificate. Sent on every execute for the reason above
	 * and one more: the engine's default is `true`, so an omitted `false`
	 * verifies the certificate the user turned verification off for - the
	 * default winning silently is a security decision here, not a surprise
	 * (issue #706).
	 */
	verifySSL?: boolean;
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
	/**
	 * Consume the response as a `text/event-stream` instead of buffering it
	 * (issue #573). It changes the *execution model*, not a transfer option, so
	 * the endpoint answers `202` with {@link ExecuteStreamResponse} rather than
	 * the exchange.
	 *
	 * Sent on **every** execute, never elided when false - the same
	 * single-choke-point rule the redirect policy and `httpVersion` follow, and
	 * for a sharper reason here: the two answers have different *shapes*, so a
	 * caller that let an engine-side default decide would not know which one it
	 * was about to parse.
	 *
	 * The engine refuses `stream` combined with `transient` (a stream is its run
	 * row) with a `400` naming why. Scripts are not refused: the pre-request one
	 * runs before the transfer and the post-request one after the stream ends,
	 * reading its events as `pm.response.events` (issue #575). Their output is
	 * stored on the run's trace, since the endpoint answered `202` long before
	 * the post-request script ran.
	 */
	stream?: boolean;
	/**
	 * One data row to bind before the request goes out (issue #601).
	 *
	 * The single-send half of `scenario.data`: `{{data.column}}` tokens in the
	 * URL, headers, body, form fields and auth credentials are substituted
	 * against it, and both scripts read it as `pm.iterationData`
	 * (`pm.info.iteration` is 0 - the send *is* row 0 of 1). Absent is the
	 * ordinary send, where those tokens go out written as they stand and
	 * `pm.iterationData` is `undefined`.
	 *
	 * An object of name/value pairs, never the array a run sends: one row. A
	 * column the row does not carry is a `400` naming the token and the row's
	 * own columns, and nothing is sent - the same refusal a run makes per
	 * iteration, moved to before the run row exists.
	 *
	 * Credentials bind **before** they are encoded (issue #642), so basic auth
	 * base64s the row's values rather than the token text - the same deferral a
	 * collection run performs per iteration (issue #591). OAuth 2.0 is the one
	 * mode no row can reach, because its token is acquired against the token
	 * endpoint instead of being written into the request; a `{{data.*}}` in an
	 * oauth2 config is a `400` naming the token.
	 */
	data?: Record<string, unknown>;
}

export type ExecuteRequestResponse = SanityResult;

/**
 * What `POST /execute` answers for a streaming request: `202`, at once, with
 * the run row it created and the URL its events arrive on. There is no
 * exchange to return - the transfer has only just been handed to the engine's
 * consumer worker.
 *
 * `eventsUrl` is engine-relative (`/runs/:id/events`) and is used **as given**
 * rather than rebuilt from `runId`: the engine names where its own events are,
 * and a second spelling of that path in `api-endpoints.ts` would be a copy that
 * can disagree with the answer. An answer missing either field is a malformed
 * answer and fails loudly rather than being guessed at.
 */
export interface ExecuteStreamResponse {
	runId: string;
	eventsUrl: string;
	status: string;
}

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

	/** TLS verification - same rationale, and see {@link Request.verifySSL}. */
	verifySSL?: boolean;

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

	/**
	 * Consume each transfer as a `text/event-stream` (issue #576).
	 *
	 * The same flag and the same two cap names `POST /execute` takes, because
	 * the engine reads both endpoints through one parser - a load run declares
	 * a stream exactly as a Send does. Sent from the request's own `stream`
	 * setting, never from the load dialog: whether a request streams is a
	 * property of the request, and only the bounds below belong to the run.
	 */
	stream?: boolean;
	/**
	 * Wall-clock ceiling on one stream, in ms; omitted takes the engine's
	 * `sseMaxStreamDurationMs`. Under load a stream is bounded by construction -
	 * the load loop refills concurrency per completion, so a transfer that
	 * never ends leaks its slot for the rest of the run - and reaching a cap is
	 * a **successful** completion rather than a timeout.
	 */
	maxStreamDurationMs?: number;
	/** Ceiling on events delivered by one stream; omitted takes `sseMaxStreamEvents`. */
	maxStreamEvents?: number;
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
		 * present-but-empty array. The row *set* is never persisted on either
		 * side - the run snapshot records its count alone - but a cell bound
		 * into a request is stored with that request, in the step trace the run
		 * keeps (issue #731).
		 */
		data?: Record<string, unknown>[];
	};
	/** What `{{variables}}` resolve against, and whose cookie jar the run uses. */
	environmentId?: string;
	/**
	 * Make the collection's OpenAPI contract a gate: a step that passed
	 * everything else and whose response does not match the schema the bound
	 * document declares is **failed** (issue #720).
	 *
	 * Top-level rather than inside `scenario`, because that is where the engine
	 * reads it (`read_fail_on_schema_error`), beside the other run-scoped
	 * properties of who asked for the run.
	 *
	 * **Omitted when off**, unlike `followRedirects`: the engine's default is
	 * `false`, so absent already means what the user asked for, and a run
	 * snapshot that carries the key only when it was on keeps a payload written
	 * before this existed reading the same way. Design-mode collection runs
	 * only - the load executor defers validation to run end and never demotes a
	 * step on it.
	 */
	failOnSchemaError?: boolean;
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

// Client-certificate registry (issue #707)

/**
 * One registry entry, as `GET /client-certificates` reports it.
 *
 * The passphrase is deliberately absent: the engine never echoes it (it is
 * write-only over the wire), so this shape carries `hasPassphrase` instead -
 * which is the only thing the card has to render. Sending it back would put a
 * secret into every screenshot of the Settings panel.
 */
/**
 * What the certificate file holds (issue #833). `pem` keeps the key in a second
 * file; `p12` is a PKCS#12 bundle carrying both. Every platform reads both
 * shapes since issue #851 - the engine still stores which one it is, because
 * libcurl needs telling (`CURLOPT_SSLCERTTYPE`) and would otherwise hand a
 * bundle to its PEM parser.
 */
export type ClientCertificateFormat = "pem" | "p12";

export interface ClientCertificate {
	id: string;
	/**
	 * Lower-cased hostname, no scheme or port - the engine stores it this way -
	 * or the one wildcard form, `*.example.com`, which answers for every
	 * subdomain and never for the domain itself (issue #803).
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
 * A create or update body. `port: null` means every port, and on an update
 * `passphrase: null` clears a stored one - the engine's standard
 * null-vs-absent rule, which is why both are nullable rather than optional.
 */
export interface ClientCertificateInput {
	host: string;
	port: number | null;
	certPath: string;
	/**
	 * Absent lets the engine read the format off the file, which is what a
	 * caller that has no opinion should do. Naming it is checked against those
	 * same bytes, so a wrong value is a `400` rather than a handshake failure
	 * later.
	 */
	certFormat?: ClientCertificateFormat;
	/** `null` clears a stored path - how an entry moves from `pem` to `p12`. */
	keyPath: string | null;
	passphrase?: string | null;
}

// Transport diagnostics (issue #708)

/**
 * Which hop answered, and how.
 *
 * Coarser than the engine's `ErrorCode` on purpose: the reader is choosing
 * which setting to point a user at, and these are the outcomes that lead
 * somewhere different. Everything else is `failed`, carrying the engine's own
 * message rather than a fourth word that implies a fourth remedy.
 */
export type ConnectionTestOutcome = "ok" | "proxy_failed" | "tls_failed" | "timed_out" | "failed";

/**
 * What `POST /diagnostics/connection` answers with.
 *
 * There is no response body here and there must never be one: this is a
 * diagnostics surface, not a fetch proxy (that is `/import/fetch`, behind its
 * own byte bound).
 */
export interface ConnectionTestResult {
	url: string;
	outcome: ConnectionTestOutcome;
	/** The proxy the test actually went through. */
	proxy: {
		/** The `proxyMode` in force - `environment`, `system`, `manual` or `off`. */
		mode: string;
		/**
		 * The proxy URL, absent when the engine does not know it - which is
		 * every `environment`-mode test, since libcurl reads those variables
		 * itself. Absent means "not the engine's to say", never "no proxy".
		 */
		url?: string;
	};
	/** The registry entry that answered for this host, `""` when none did. */
	clientCertificate: string;
	/** The status line, present only on `ok`. */
	status?: number;
	/** The engine's `ErrorCode` spelling, absent on `ok`. */
	errorCode?: string;
	/** libcurl's own message, absent on `ok`. */
	detail?: string;
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
	/**
	 * How many captures this inbox is holding - what deleting it would destroy.
	 *
	 * Up to one services poll old, so a surface that also holds the capture list
	 * knows better; see `capturesAtRisk` in `modules/inbox/useInboxDeletion.ts`.
	 */
	captureCount: number;
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

/** What `DELETE /inbox/:id` reports it destroyed - record plus captures. */
export interface DeleteInboxResponse {
	inboxId: string;
	capturesDeleted: number;
}

// OAuth 2.0 mock issuer API (issue #479). Engine-process state like an inbox:
// the engine holds each issuer on its own loopback listener and a restart
// forgets every one of them, so nothing here is stored client-side either.

/** What `/token` answers with, so retry and error handling are testable. */
export type MockIssuerFailureMode = "none" | "slow" | "server_error" | "invalid_client";

/** One running issuer, as `GET /mock-issuer` and the `PUT` reply describe it. */
export interface MockIssuer {
	issuerId: string;
	/** Base URL - the OAuth `iss` of every token it mints. */
	issuerUrl: string;
	tokenUrl: string;
	authorizeUrl: string;
	/** HS256 secret the service under test verifies this issuer's tokens with. */
	signingKey: string;
	port: number;
	expiresInSeconds: number;
	failureMode: MockIssuerFailureMode;
	/** How long `slow` mode waits before answering; ignored in every other mode. */
	slowMs: number;
	issueRefreshTokens: boolean;
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
}

/**
 * The start call answers with the URLs and the key only - not the full record.
 * The list is what carries the settings back, which is why starting one
 * invalidates it rather than writing the reply into the cache.
 */
export interface StartMockIssuerResponse {
	issuerId: string;
	issuerUrl: string;
	tokenUrl: string;
	authorizeUrl: string;
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

// Collection mock server API (issue #481 phase 2). Engine-process state like an
// inbox or an issuer: the engine holds each mock on its own loopback listener,
// serving the collection's saved examples, and a restart forgets every one.

/** One running mock server, as `POST /mock/start` and `GET /mock` describe it. */
export interface MockServer {
	mockId: string;
	collectionId: string;
	/** Named at start time - the collection may since have been renamed. */
	collectionName: string;
	/** `http://127.0.0.1:<port>`, with no trailing slash: a base to point at. */
	url: string;
	port: number;
	latencyMs: number;
	errorRatePct: number;
	/** Requests in the collection subtree the mock is serving. */
	routeCount: number;
	/**
	 * How many of those have no saved example and so answer 501.
	 *
	 * The number that explains an otherwise empty-looking mock, which is why it
	 * is reported rather than left to be discovered one 501 at a time.
	 */
	routesWithoutExample: number;
	createdAt: number;
}

export interface StartMockServerRequest {
	collectionId: string;
	/** 0 (the default) binds an ephemeral port. */
	port?: number;
	/** Artificial delay before every answer, 0-30000. */
	latencyMs?: number;
	/** Share of answers replaced by a synthesized 500, 0-100. */
	errorRatePct?: number;
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
}

export interface ListMockServerRoutesResponse {
	data: MockServerRoute[];
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
	/**
	 * The spec document this collection binds, named by the payload's own temp id
	 * (issue #637). `specTempId` and not `specId`: the document is created by the
	 * same call, so its engine id does not exist yet - the engine resolves the
	 * temp id and stores the real one, and `specTempId` is never persisted.
	 */
	openapi?: { specTempId: string };
}

/**
 * An OpenAPI document riding along with the import that produced the tree
 * (issue #637).
 *
 * A fourth top-level section rather than a field on the collection, because a
 * spec is a resource of its own that several collections may bind - it gets a
 * temp id, appears in the `idMap`, and is referenced by
 * {@link ImportApplyCollection.openapi}.
 */
export interface ImportApplySpec {
	tempId: string;
	content: string;
	/** Absent when the document did not come from a URL (a file or a paste). */
	sourceUrl?: string;
	/**
	 * What the document declares (issue #629), stored beside it so a run of the
	 * imported collection can report its contract coverage. Absent for a document
	 * the parsers produced no index for.
	 */
	operations?: DeclaredOperation[];
	/**
	 * The response schemas the document declares (issue #628), stored beside it
	 * so a response can be checked against its contract. Absent for a document
	 * that declares none, which the engine stores as "no index" - a response of
	 * it reports that nothing checked it, never that it passed.
	 */
	responseSchemas?: ResponseSchemaIndex;
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
	/** Omitted unless the source was a spec that named this request's operation. */
	specOperation?: SpecOperation;
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
	/**
	 * Spec documents this payload creates. Always sent, `[]` included: the engine
	 * reads an absent section as "none", and stating it keeps the payload one
	 * shape for every format rather than one the OpenAPI parsers grow a key on.
	 */
	specs: ImportApplySpec[];
}

export interface ImportApplyResponse {
	/** Every `tempId` sent, mapped to the engine-generated id it became. */
	idMap: Record<string, string>;
}

// Specs API (issue #637). Create-only and read-by-id: a document that changed
// is a different document, so there is no PUT - a re-fetch stores a new one and
// moves the binding.

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
	 * The declared-operation index stored beside the document (issue #629).
	 *
	 * `null` - not `[]` - for a document stored before the index existed or by a
	 * client that sends none, so "coverage was never extractable for this
	 * document" reads differently from "this document declares nothing".
	 */
	operations: DeclaredOperation[] | null;
	/**
	 * The response schema index (issue #628), `null` on the same terms as
	 * `operations` above: a document stored before schemas were extracted reads
	 * differently from one whose operations declare none.
	 */
	responseSchemas: ResponseSchemaIndex | null;
}

/**
 * A stored document described rather than transferred (issue #712).
 *
 * `GET /specs/:id/meta` - what the Spec tab's card needs to paint a source, a
 * date and a size, without the up-to-`maxSpecDocumentBytes` document behind it
 * (12 MB for Stripe's spec) riding along on a tab opening. The fields it does
 * carry are the document's own, value for value; `content`, `operations` and
 * `responseSchemas` are **absent**, not empty, so "not read here" cannot be
 * mistaken for "this document has none".
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
	 * What the document declares, extracted by whichever parser read it
	 * (issue #629). Omitted for a document nothing here parsed, which the engine
	 * stores as "no index"; a run of the bound collection then reports no
	 * coverage rather than an empty contract.
	 */
	operations?: DeclaredOperation[];
	/**
	 * The response schemas the document declares (issue #628), stored beside it
	 * so a response can be checked against its contract. Absent for a document
	 * that declares none, which the engine stores as "no index" - a response of
	 * it reports that nothing checked it, never that it passed.
	 */
	responseSchemas?: ResponseSchemaIndex;
}

// Spec sync (issue #655) - `POST /specs/sync` applies a re-fetched document to
// the collection bound to it: the document is stored, the binding moves to it,
// and the selected operations are created, updated and deleted in one
// transaction. Separate from `/import/apply` because that route only ever
// creates; see engine/src/http/routes/spec_sync.cpp.

/** A tag folder an added operation needs and the collection does not have yet. */
export interface SpecSyncCollection {
	tempId: string;
	name: string;
	/** Absent means the collection being synced; anything else must be beneath it. */
	parentId?: string;
	description?: string;
}

/** An operation the document added, as the request it becomes. */
export type SpecSyncCreate = Omit<ImportApplyRequestItem, "collectionTempId"> & {
	/** The stored collection it lands in - or `collectionTempId`, never both. */
	collectionId?: string;
	collectionTempId?: string;
};

/**
 * A merge-patch on one stored request: only the fields the user chose to take
 * from the document, plus the identity when the document moved it.
 *
 * `examples` present replaces the request's imported examples with these and
 * leaves the ones saved from live responses alone; absent leaves all of them.
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
	examples?: ImportApplyExample[];
}

export interface SpecSyncRequest {
	/** The bound collection. Nothing outside its subtree is written. */
	collectionId: string;
	/** The re-fetched document. `hash` and `fetchedAt` are engine-computed. */
	spec: {
		content: string;
		sourceUrl?: string | null;
		/**
		 * The re-fetched document's declared-operation index (issue #629). Sent
		 * on every sync for the same reason the content is: the new document is
		 * a new row, and a sync that omitted it would silently turn coverage off
		 * for a collection that had it.
		 */
		operations?: DeclaredOperation[];
		/** The same, for the response schema index (issue #628). */
		responseSchemas?: ResponseSchemaIndex;
	};
	collections: SpecSyncCollection[];
	create: SpecSyncCreate[];
	update: SpecSyncUpdate[];
	/** Request ids. One already deleted is not an error - it is the asked-for state. */
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
