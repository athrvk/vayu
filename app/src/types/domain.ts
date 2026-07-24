/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Core Domain Types

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type BodyMode = "none" | "json" | "text" | "graphql" | "form-data" | "x-www-form-urlencoded";

export type AuthMode =
	| "none"
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

export type RequestAuth =
	| { mode: "none" | "inherit" }
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
}

/**
 * Extended variable info for autocomplete and quick view.
 */
export interface VariableInfo extends ResolvedVariable {
	name: string;
	sourceId?: string; // Collection ID or Environment ID
	sourceName?: string; // Collection name or Environment name
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
	headers?: Record<string, string>;
	body?: string;
	// Design-mode traces (`POST /request`) nest the exchange instead of
	// flattening it - see `store_result` in engine/src/http/routes/execution.cpp.
	request?: {
		method?: string;
		url?: string;
		headers?: Record<string, string>;
		body?: string;
	};
	response?: {
		headers?: Record<string, string>;
		body?: unknown;
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

export interface Run {
	id: string;
	type: "load" | "design";
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	endTime: number;
	configSnapshot?: RunConfigSnapshot;
	requestId?: string | null;
	environmentId?: string | null;
	/** The exchange, present only for a design run once it has completed or failed. */
	result?: RunResult;
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
	data_sample_rate?: number;
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
 * `queueWaitMs` are the two the design-mode writer omits, so they are absent
 * on a restored response; every consumer must treat both as optional.
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
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

export interface SanityResult extends HttpResponse {
	requestId?: string;
	testResults?: TestResult[];
	consoleLogs?: string[];
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
	type: "integer" | "string" | "boolean" | "number";
	label: string;
	description: string;
	category: string;
	default: string;
	min?: string;
	max?: string;
	updatedAt: number;
	requiresRestart?: boolean;
}

/** Client-side settings panels (localStorage-backed prefs, rendered by app panels). */
export type ClientSettingsCategory = "appearance" | "editor" | "dashboard" | "general" | "mcp";

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
