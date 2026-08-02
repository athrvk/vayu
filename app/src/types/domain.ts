/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Core Domain Types

/**
 * HTTP protocol to negotiate. Declared in `@/constants/request` (derived from
 * the `HTTP_VERSIONS` list, the single source of truth also consumed by the
 * Settings tab picker) and re-exported here, same pattern as `ColorScheme` in
 * `types/ui.ts`, so `Request.httpVersion` below can reference it.
 */
import type { HttpVersion } from "@/constants/request";
export type { HttpVersion };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type BodyMode = "none" | "json" | "text" | "graphql" | "form-data" | "x-www-form-urlencoded";

export type AuthMode =
	| "none"
	| "noauth"
	| "inherit"
	| "bearer"
	| "basic"
	| "apikey"
	| "oauth2"
	| "digest"
	| "aws"
	| "ntlm";

/**
 * A single key-value entry (headers, params, form fields).
 * `enabled: false` rows are preserved in storage and excluded only at HTTP-execution time.
 * Duplicates are allowed (useful for multiple `Accept` headers etc.).
 */
export interface KeyValueEntry {
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
}

/**
 * Variable value with enabled flag and optional type hint.
 * Note: `secret` is a UI masking hint - values are NOT encrypted at rest.
 * Note: `type` affects UI rendering and validation only; values are always stored as strings.
 */
export interface VariableValue {
	value: string;
	enabled: boolean;
	secret?: boolean;
	type?: "string" | "number" | "boolean" | "json";
	createdAt?: number;
}

/**
 * Request body as a discriminated union.
 * `body_type` on the domain `Request` is a denormalized mirror of `body.mode`.
 */
export type RequestBody =
	| { mode: "none" }
	| { mode: "json" | "text" | "graphql"; content: string }
	| { mode: "form-data" | "x-www-form-urlencoded"; fields: KeyValueEntry[] };

/**
 * Auth configuration for requests.
 * `inherit` resolves by walking the parent collection chain at execution time.
 * Collections never use `inherit` - they are always the auth source.
 */
export type OAuth2GrantType = "authorization_code" | "client_credentials" | "password";

/**
 * OAuth 2.0 configuration. Every string field may contain {{variables}},
 * resolved app-side before the config is sent to the engine. `state` is
 * intentionally absent - it is always generated per authorization attempt.
 */
export interface OAuth2Config {
	grantType: OAuth2GrantType;
	authorizationUrl?: string; // authorization_code only
	accessTokenUrl: string;
	refreshTokenUrl?: string; // defaults to accessTokenUrl
	callbackUrl?: string; // authorization_code; empty = auto loopback
	clientId: string;
	clientSecret?: string;
	credentialsPlacement?: "basic_auth_header" | "body"; // default basic_auth_header
	username?: string; // password grant
	password?: string; // password grant
	pkce?: boolean; // default true (authorization_code)
	scope?: string;
	audience?: string;
	resource?: string;
	tokenPlacement?: "header" | "query"; // default header
	headerPrefix?: string; // default "Bearer"
	queryParamName?: string; // default "access_token"
	autoFetchToken?: boolean; // default true
	autoRefreshToken?: boolean; // default true
	useEmbeddedBrowser?: boolean; // default false
	credentialsId?: string; // default "default"
}

/**
 * `none` vs `noauth` - the distinction the inheritance walk turns on.
 *
 * On a collection, `none` means "nothing configured here": the walk steps past
 * it and a descendant `inherit` keeps climbing. `noauth` means "configured to
 * send nothing", which *terminates* the walk - descendants inherit no
 * credentials. Postman draws the same line (a folder set to No Auth blocks
 * inheritance; a folder left on Inherit does not), and collapsing the two is how
 * an imported No Auth folder used to leak its parent's bearer token (issue
 * #195). `resolveAuthSource` in `modules/request-builder/utils/auth-resolution.ts`
 * is the one place that reads the difference, mirrored for MCP in
 * `electron/mcp/resolve.ts`.
 *
 * On a *request* the two coincide - a request's own auth is never walked, so
 * `none` already means send nothing - which is why only the collection editor
 * offers `noauth`.
 */
export type RequestAuth =
	| { mode: "none" | "noauth" | "inherit" }
	| { mode: "bearer"; token: string }
	| { mode: "basic"; username: string; password: string }
	| { mode: "apikey"; key: string; value: string; in: "header" | "query" }
	| { mode: "oauth2"; config: OAuth2Config }
	| { mode: "digest" | "aws" | "ntlm"; config: Record<string, unknown> };

export interface Collection {
	id: string;
	name: string;
	description: string;
	parentId?: string;
	order: number;
	variables: Record<string, VariableValue>;
	auth: Exclude<RequestAuth, { mode: "inherit" }>; // Collections are auth sources, never inherit
	preRequestScript: string;
	postRequestScript: string;
	createdAt: string;
	updatedAt: string;
}

/** Stable comparator for sorting collections by order, then by id. */
export function compareCollectionOrder(a: Collection, b: Collection): number {
	const orderDiff = (a.order ?? 0) - (b.order ?? 0);
	if (orderDiff !== 0) return orderDiff;
	return (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * One part of a script that runs for a request, and where it came from.
 *
 * The clients used to join the collection chain's scripts with the request's
 * own and send a single string, so a stored run could not say which part came
 * from where - and writing that string back to a request would put the
 * collection's script inside it permanently. The engine joins them now.
 *
 * `origin`/`id`/`name` are sent and persisted starting with this change, but
 * nothing in the app reads them back yet - that is intentional groundwork for
 * the run/history views (not yet built) to attribute a script failure to the
 * collection or request it came from. Do not read this as dead weight; it is
 * the next layer's job to add the reader.
 */
export interface ScriptPart {
	origin: "collection" | "request";
	id?: string;
	/** Collection name, for showing the user where a part came from. */
	name?: string;
	script: string;
}

export interface Request {
	id: string;
	collectionId: string;
	name: string;
	description: string;
	method: HttpMethod;
	url: string;
	params: KeyValueEntry[];
	headers: KeyValueEntry[];
	body: RequestBody;
	bodyType: BodyMode; // Denormalized mirror of body.mode - kept for queryability
	auth: RequestAuth;
	preRequestScript: string;
	postRequestScript: string;
	/** Follow 3xx `Location` responses. Engine default is `true`. */
	followRedirects: boolean;
	/** Redirect hops allowed when {@link followRedirects} is on. Engine default is 10. */
	maxRedirects: number;
	/**
	 * HTTP protocol to negotiate for this request. `"auto"` lets curl pick
	 * (ALPN over TLS, HTTP/1.1 otherwise) - see {@link HTTP_VERSIONS}. This is
	 * the *requested* protocol; the protocol actually negotiated for a given
	 * response is `ResponseState.httpVersion`, a different, display-string
	 * value space - do not unify them.
	 */
	httpVersion: HttpVersion;
	order: number;
	createdAt: string;
	updatedAt: string;
}

/** Stable comparator for sorting requests within a collection. */
export function compareRequestOrder(a: Request, b: Request): number {
	const orderDiff = (a.order ?? 0) - (b.order ?? 0);
	if (orderDiff !== 0) return orderDiff;
	return (a.id ?? "").localeCompare(b.id ?? "");
}

export interface Environment {
	id: string;
	name: string;
	description: string;
	variables: Record<string, VariableValue>;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Global variables - singleton storage for app-wide variables
 */
export interface GlobalVariables {
	id: string; // Always "globals"
	variables: Record<string, VariableValue>;
	updatedAt: string;
}

/**
 * Variable scope for UI display and resolution priority.
 * Resolution priority: Environment > Collection (leaf-to-root) > Global
 */
export type VariableScope = "global" | "collection" | "environment";

/**
 * Resolved variable with its value, scope, and secret flag.
 * Note: The `secret` field is a UI hint for masking - values are NOT encrypted at rest.
 *
 * `value` is always the raw string form (used for `{{var}}` interpolation in
 * URLs / headers / body). `type` and `typedValue` expose the declared
 * conversion for consumers that want the cast JS value (scripts, autocomplete).
 */
export interface ResolvedVariable {
	value: string;
	scope: VariableScope;
	secret?: boolean;
	type?: VariableValue["type"];
	typedValue?: unknown;
	/**
	 * Which collection or environment this value came from. Absent for `global`,
	 * which is a singleton and has no name to give.
	 *
	 * These sat on `VariableInfo` for a long time, declared and never written by
	 * anything in `src/` - so the popover could say a variable came from "an
	 * environment" but not *which* one, in an app where having several is the
	 * point. Moved down to `ResolvedVariable` because the resolver is what knows,
	 * and it produces this type.
	 */
	sourceId?: string;
	sourceName?: string;
}

/**
 * One definition of a variable name, at one scope.
 *
 * The resolver flattens every scope into a single winner, which is all execution
 * needs and strictly less than the UI needs: "why is this the value?" cannot be
 * answered from the winner alone. Two cases in particular are invisible without
 * the losers - a name defined at several scopes, and a name whose highest-scope
 * definition is *disabled*, which is the most common reason a value is not the
 * one you expected.
 *
 * Disabled definitions are therefore kept here even though they never resolve.
 */
export interface VariableOrigin {
	scope: VariableScope;
	/** Absent for `global`, as on ResolvedVariable. */
	sourceId?: string;
	sourceName?: string;
	value: string;
	secret?: boolean;
	/** The declared conversion, carried so the winner can rebuild `typedValue`. */
	type?: VariableValue["type"];
	/** A disabled definition is listed but never wins. */
	enabled: boolean;
	/**
	 * The definition that actually resolves. Exactly one origin per name carries
	 * this, unless every definition is disabled, in which case none does.
	 *
	 * Explicit rather than "the last one", because precedence order and win order
	 * are not the same list once disabled definitions are included.
	 */
	winner: boolean;
}

/**
 * Extended variable info for autocomplete and quick view.
 */
export interface VariableInfo extends ResolvedVariable {
	name: string;
}

/**
 * Flat snapshot of the request + load-test parameters captured when a run
 * starts, persisted with the Run for history display. Known fields are typed;
 * the index signature permits additional engine-provided keys.
 */
export interface RunConfigSnapshot {
	url?: string;
	method?: string;
	mode?: string;
	duration?: string;
	targetRps?: number;
	concurrency?: number;
	iterations?: number;
	rampUpDuration?: string;
	startConcurrency?: number;
	comment?: string;
	/**
	 * Requested protocol the run executed with - `build_run_report_config` in
	 * `engine/src/http/routes/runs.cpp` normalizes an absent or explicit-`null`
	 * key to `"auto"` before this ever reaches the client, so it is always
	 * present in practice despite the optional `?`. Distinct from the
	 * *negotiated* protocol on a single exchange (`ResponseState.httpVersion`).
	 */
	httpVersion?: HttpVersion;
	[key: string]: unknown;
}

/**
 * One HTTP exchange's trace, as the engine stores it. A design-mode trace
 * (`POST /request` -> `store_result`, execution.cpp) nests the request and
 * response; a load-test trace flattens timing and status onto the object
 * directly. Both writers omit fields freely, so everything here is optional.
 * Named once and shared by {@link RunResult} and {@link RunReport} rather
 * than declared inline in both places.
 */
export interface RunResultTrace {
	totalMs?: number;
	/** libcurl's transfer time; `queueWaitMs` is generator-side overhead. Both
	 * writers store them now, but rows persisted by older engines lack them. */
	wireMs?: number;
	queueWaitMs?: number;
	dnsMs?: number;
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	downloadMs?: number;
	isSlow?: boolean;
	thresholdMs?: number;
	request_number?: number;
	error_code?: number;
	/** `to_string(ErrorCode)` - the same words a live `errorCode` uses. */
	error_type?: string;
	/** The load-test writer's failure text (`load_strategy.cpp`). */
	message?: string;
	/** The design-mode writer's failure text (`store_result`, execution.cpp). */
	error_message?: string;
	/**
	 * Per-test validation failures from a load run's `validate_scripts`
	 * (`run_manager.cpp`), stored on the summary result row's trace. Each entry
	 * is a `"<test name>: <assertion>"` line (or a `Script error:` / `Exception:`
	 * line when the whole script threw). Written by the engine but rendered
	 * nowhere before issue #111.
	 */
	failures?: string[];
	totalFailed?: number;
	totalPassed?: number;
	headers?: Record<string, string>;
	body?: string;
	// Design-mode traces (`POST /request`) nest the exchange instead of
	// flattening it - see `store_result` in engine/src/http/routes/execution.cpp.
	request?: {
		method?: string;
		url?: string;
		headers?: Record<string, string>;
		body?: string;
		/** Set by `store_result` when the request body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The request body's original byte length, present only when truncated. */
		bodyBytes?: number;
	};
	response?: {
		headers?: Record<string, string>;
		body?: unknown;
		/** Set by `store_result` when the response body exceeded `maxTraceBodyBytes`. */
		bodyTruncated?: boolean;
		/** The response body's original byte length, present only when truncated. */
		bodyBytes?: number;
		/**
		 * The protocol negotiated for this exchange, as stored by
		 * `build_result_trace` (`engine/src/http/routes/execution.cpp`) - same
		 * display-string value space as `ResponseState.httpVersion`
		 * (`app/src/modules/request-builder/types.ts`), not the request-side
		 * `HttpVersion` union. Read by `restore-response.ts`'s `sentSide` (onto
		 * the rebuilt raw request line) and `responseFromRunResult` (onto
		 * `ResponseState.httpVersion`, for the Raw tab's status line).
		 */
		httpVersion?: string;
		/**
		 * This exchange asked for HTTP/2 and negotiated something older - see
		 * {@link HttpResponse.httpVersionDowngraded}. Absent on a trace stored
		 * by an engine older than 0.15.0, which is why it is optional rather
		 * than defaulted to `false` at the type level.
		 */
		httpVersionDowngraded?: boolean;
	};
}

/**
 * The single exchange for a design run, attached by `GET /runs/:id` -
 * `attach_design_result` in engine/src/utils/json.cpp. Design runs only: a
 * design run has exactly one result, so the engine embeds it on the run
 * itself instead of requiring a second `/results` fetch.
 */
export interface RunResult {
	timestamp: number;
	statusCode: number;
	statusText: string;
	latencyMs: number;
	error?: string;
	trace?: RunResultTrace;
}

/**
 * The compact per-row summary the paginated `GET /runs` list carries in place
 * of the full {@link RunConfigSnapshot}. Mirrors all nine keys
 * `build_run_summary` sends (`engine/src/http/routes/runs.cpp`); each is
 * omitted by the engine when absent from the stored snapshot, except
 * `httpVersion` which the engine always normalizes to a value (see
 * `add_http_version`, same file). The full snapshot is still available on
 * `GET /runs/:id`.
 *
 * `followRedirects` / `maxRedirects` are declared but **not rendered
 * anywhere yet** - this type mirrors the wire, so a field the engine sends is
 * declared whether or not a screen reads it, and a reader can trust that what
 * is missing here is missing from the payload too. If you are looking for
 * somewhere to surface them, the history sidebar row and the load test report
 * both already show `httpVersion` and would be the consistent home.
 */
export interface RunSummary {
	url?: string;
	method?: string;
	mode?: string;
	duration?: string;
	concurrency?: number;
	comment?: string;
	/** Requested protocol - see {@link RunConfigSnapshot.httpVersion}. */
	httpVersion?: HttpVersion;
	/** Sent by the engine, not yet rendered - see the note above. */
	followRedirects?: boolean;
	/** Sent by the engine, not yet rendered - see the note above. */
	maxRedirects?: number;
}

export interface Run {
	id: string;
	type: "load" | "design";
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	endTime: number;
	/**
	 * Present on list rows from the paginated `GET /runs`. The single-run
	 * `GET /runs/:id` returns {@link configSnapshot} instead.
	 */
	summary?: RunSummary;
	/** Full snapshot - present on `GET /runs/:id`, not on paginated list rows. */
	configSnapshot?: RunConfigSnapshot;
	requestId?: string | null;
	environmentId?: string | null;
	/** The exchange, present only for a design run once it has completed or failed. */
	result?: RunResult;
}

/** The `{data, pagination}` envelope the paginated `GET /runs` returns. */
export interface RunListResponse {
	data: Run[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
}

/** Server-side filters for the paginated `GET /runs` list. */
export interface RunListParams {
	limit?: number;
	offset?: number;
	type?: "load" | "design";
	status?: Run["status"];
	requestId?: string;
	q?: string;
}

/** Load-test execution strategy. Single source of truth for the mode union. */
export type LoadTestMode = "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up";

export interface LoadTestConfig {
	duration_seconds?: number;
	rps?: number;
	concurrency?: number;
	iterations?: number;
	mode: LoadTestMode;
	ramp_duration_seconds?: number;
	/** Ramp-Up only: connections at t=0, climbing to `concurrency`. */
	start_concurrency?: number;
	/**
	 * Sampling **period** for stored success traces - keep 1 in N, engine-side
	 * `counter % N`. Named for the unit on purpose: the dialog's control is a
	 * percentage, and the two used to be the same number, so the slider meant
	 * the inverse of its own label. `successSamplePeriod` does the conversion.
	 */
	success_sample_period?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	comment?: string;
	latency_percentiles?: number[];
	max_in_flight?: number;
}

/**
 * Per-request timing breakdown (milliseconds), as `POST /execute` returns it
 * (`serialize(Response)`, engine/src/utils/json.cpp). Phase fields
 * (dns…download) are sequential segments of the request; `wireMs` is libcurl's
 * transfer time and `queueWaitMs` is generator-side overhead (total − wire).
 *
 * The field names are the engine's wire keys - the same `*Ms` convention the
 * stored trace ({@link RunResultTrace}) uses, so a live response and one
 * restored from a stored design run agree without renaming. `wireMs` /
 * `queueWaitMs` stay optional because traces stored by older engines omitted
 * them (current ones store all eight); consumers must treat both as optional.
 */
export interface ResponseTiming {
	totalMs: number;
	wireMs?: number;
	queueWaitMs?: number;
	dnsMs: number;
	connectMs: number;
	tlsMs: number;
	firstByteMs: number;
	downloadMs: number;
}

export interface HttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: unknown;
	bodyRaw: string;
	bodySize: number;
	timing: ResponseTiming;
	errorCode?: string;
	errorMessage?: string;
	/**
	 * The protocol negotiated for this exchange, as `serialize(Response)`
	 * (`engine/src/utils/json.cpp`) emits it on `POST /execute` - `""` when
	 * nothing was negotiated, not omitted. Same display-string value space as
	 * `ResponseState.httpVersion` (`app/src/modules/request-builder/types.ts`),
	 * not the request-side `HttpVersion` union - do not unify the two.
	 */
	httpVersion?: string;
	/**
	 * The request asked for `http2` and the connection negotiated something
	 * older. Computed engine-side (`http_version_downgraded`,
	 * `engine/include/vayu/http/curl_version_map.hpp`) because only the engine
	 * holds both halves at once - `httpVersion` above is the outcome, and the
	 * outcome only becomes a complaint next to what was requested.
	 *
	 * Do not re-derive it here from the tab's `httpVersion` setting: a replay
	 * or a restored response is shown beside request state that may since have
	 * changed, and the answer belongs to the exchange, not to the editor.
	 */
	httpVersionDowngraded?: boolean;
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

/** Which `console.*` method a script line came from. Engine spellings. */
export type ConsoleLevel = "log" | "info" | "warn" | "error";

/** Which of a request's two scripts wrote a line. */
export type ConsoleLogSource = "pre" | "test";

/**
 * One line of script console output.
 *
 * The engine used to send a bare string and encode the source as a `"[pre] "`
 * text prefix, which was indistinguishable from a script that logged a line
 * starting with those characters - and carried no level at all, so the Console
 * tab drew `console.error` exactly like `console.log`. Both are fields now.
 */
export interface ConsoleLogEntry {
	source: ConsoleLogSource;
	level: ConsoleLevel;
	message: string;
}

export interface SanityResult extends HttpResponse {
	requestId?: string;
	testResults?: TestResult[];
	/**
	 * A `string` is the pre-structured shape, kept in the type so the fallback in
	 * `parse-logs.ts` is visible rather than a cast. A renderer can meet one when
	 * it is talking to an older engine sidecar.
	 */
	consoleLogs?: Array<ConsoleLogEntry | string>;
	preScriptError?: string;
	postScriptError?: string;
	error?: string;
}

export interface LoadTestMetrics {
	timestamp: number;
	elapsed_seconds: number;
	requests_completed: number;
	requests_failed: number;
	current_rps: number;
	current_concurrency: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	avg_latency_ms: number;
	bytes_sent: number;
	bytes_received: number;
	send_rate?: number;
	throughput?: number;
	backpressure?: number;
	dropped_requests?: number;
	avg_queue_wait_ms?: number;
	// Run progress - feeds the iterations-mode ETA stat. requests_expected is 0
	// for open-ended modes (constant_rps), in which case ETA is not shown.
	requests_sent?: number;
	requests_expected?: number;
	// Per-tick full status-code map (e.g. { "200": 1450, "404": 5 }). Same shape
	// the live SSE and the stored time-series both carry.
	status_codes?: Record<string, number>;
}

export interface RunReport {
	metadata?: {
		runId: string;
		runType: string;
		status: string;
		startTime: number;
		endTime: number;
		requestUrl?: string;
		requestMethod?: string;
		configuration?: {
			mode?: string;
			duration?: string;
			targetRps?: number;
			concurrency?: number;
			startConcurrency?: number;
			rampUpDuration?: string;
			timeout?: number;
			comment?: string;
			/**
			 * Requested protocol - see {@link RunConfigSnapshot.httpVersion}. Built by
			 * `build_run_report_config` (`engine/src/http/routes/runs.cpp`), which
			 * always normalizes it to a value via `add_http_version`, so this is
			 * effectively always present despite the optional `?` - kept loosely
			 * typed as `string` (not `HttpVersion`) like its siblings above, since
			 * nothing here is runtime-validated; narrow with `isHttpVersion` before
			 * using it as a value.
			 */
			httpVersion?: string;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			followRedirects?: boolean;
			/** Sent by the engine since 0.11.0; not rendered anywhere yet. */
			maxRedirects?: number;
		};
	};
	summary: {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		errorRate: number;
		totalDurationSeconds: number;
		avgRps: number;
		sendRate?: number;
		throughput?: number;
		backpressure?: number;
		testDuration?: number;
		setupOverhead?: number;
		peakConcurrency?: number;
		droppedRequests?: number;
		avgQueueWaitMs?: number;
		bytesSent?: number;
		bytesReceived?: number;
		throughputBytesPerSec?: number;
		/**
		 * How many of the run's transfers asked for HTTP/2 and negotiated
		 * something older. The only figure in `summary` that is about the
		 * report's validity rather than its performance: non-zero means the
		 * latency and throughput above were measured over a protocol other than
		 * the one `metadata.configuration.httpVersion` names, which is exactly
		 * the mislabelling issue #215 describes. Absent from a run stored by an
		 * engine older than 0.15.0 - `undefined` means "nobody looked", not
		 * "none".
		 */
		httpVersionDowngraded?: number;
	};
	latency: {
		min: number;
		max: number;
		avg: number;
		median?: number;
		p50: number;
		p75?: number;
		p90: number;
		p95: number;
		p99: number;
		p999?: number;
	};
	statusCodes: Record<string, number>;
	errors: {
		total: number;
		withDetails: number;
		types: Record<string, number>;
		byStatusCode?: Record<string, number>;
	};
	rateControl?: {
		targetRps: number;
		actualRps: number;
		achievement: number;
	};
	timingBreakdown?: {
		avgDnsMs: number;
		avgConnectMs: number;
		avgTlsMs: number;
		avgFirstByteMs: number;
		avgDownloadMs: number;
	};
	slowRequests?: {
		count: number;
		thresholdMs: number;
		percentage: number;
	};
	testValidation?: {
		samplesTested: number;
		testsPassed: number;
		testsFailed: number;
		successRate: number;
	};
	results?: Array<{
		timestamp: number;
		statusCode: number;
		statusText?: string;
		latencyMs: number;
		error?: string;
		trace?: RunResultTrace;
	}>;
}

export interface EngineHealth {
	status: "ok";
	version: string;
	uptime_seconds: number;
}

export interface EngineConfig {
	max_concurrency: number;
	default_timeout_ms: number;
	follow_redirects: boolean;
	verify_ssl: boolean;
}

export interface ConfigEntry {
	key: string;
	value: string;
	type: "integer" | "string" | "boolean" | "number" | "enum";
	label: string;
	description: string;
	category: string;
	default: string;
	min?: string;
	max?: string;
	updatedAt: number;
	requiresRestart?: boolean;
	/**
	 * Present only on `type: "enum"` entries (e.g. `defaultHttpVersion`); the
	 * engine omits the key entirely rather than sending `null` or `[]` when a
	 * stored row's options fail to parse (`engine/src/http/routes/config.cpp`),
	 * so a renderer must treat a missing `options` as "nothing to offer", not
	 * as a bug.
	 */
	options?: { value: string; label: string }[];
}

/** Client-side settings panels (localStorage-backed prefs, rendered by app panels). */
export type ClientSettingsCategory =
	| "appearance"
	| "editor"
	| "dashboard"
	| "load-testing"
	| "notifications"
	| "general"
	| "mcp";

/** Engine settings categories (data-driven from the engine `/config` API). */
export type EngineSettingsCategory =
	| "general_engine"
	| "database_performance"
	| "network_performance"
	| "scripting_sandbox"
	| "observability";

export type SettingsCategory = ClientSettingsCategory | EngineSettingsCategory;

/**
 * MCP safety guardrails, mirrored from the Electron main process
 * (`electron/mcp/config.ts`). The renderer cannot import from `electron/`, so
 * the shape is redeclared here for the Settings panel and the preload typings.
 */
export interface McpSafetyConfig {
	/** Hostnames an agent may send traffic to. Empty = deny all (safe default). */
	allowlist: string[];
	/** When true, bypass the allowlist and allow any resolvable host. */
	allowAll: boolean;
	/** Hard ceiling on `targetRps` for load runs. */
	maxRps: number;
	/** Hard ceiling on `concurrency` for load runs. */
	maxConcurrency: number;
	/** Hard ceiling on a load run's duration, in seconds. */
	maxDurationSeconds: number;
	/** When false (default), collection/environment write tools are disabled. */
	allowWrites: boolean;
	/** Tool names the user has switched off (omitted from tools/list + rejected). */
	disabledTools: string[];
}

/** Feature grouping for the MCP tool list in Settings. */
export type McpToolCategory = "read" | "execute" | "write" | "load";

/** Metadata for one MCP tool, surfaced in Settings for enable/disable control. */
export interface McpToolInfo {
	name: string;
	description: string;
	category: McpToolCategory;
	readOnly: boolean;
}

export interface McpStatus {
	running: boolean;
	url: string;
	/** Whether the MCP server is enabled (may be enabled-but-not-running on error). */
	enabled: boolean;
}

/** Clients Vayu can register itself with via their own CLI (one-click connect). */
export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/** "cli-not-found" → the client's CLI isn't installed; fall back to the snippet. */
	reason?: "cli-not-found" | "error" | "unsupported";
	message?: string;
}

export interface ScriptCompletion {
	label: string;
	kind: number;
	insertText: string;
	insertTextRules?: number;
	detail: string;
	documentation: string;
	sortText?: string;
	filterText?: string;
}

export interface ScriptCompletionsResponse {
	version: string;
	engine: string;
	completions: ScriptCompletion[];
}

/**
 * The TypeScript declarations for the `pm.*` surface, generated engine-side
 * from the same completion table (`GET /scripting/types`).
 *
 * Feeding these to Monaco's TypeScript worker is what turns a suggestion list
 * into hover documentation, signature help and typo diagnostics. They are
 * generated rather than hand-written in this repo on purpose: a `pm.d.ts` here
 * would be a second declaration of a surface the engine owns.
 */
export interface ScriptTypeDefinitionsResponse {
	version: string;
	engine: string;
	/** Model URI the declarations are registered under - `ts:vayu/pm.d.ts`. */
	libUri: string;
	/** The `.d.ts` source itself. */
	typeDefinitions: string;
}
