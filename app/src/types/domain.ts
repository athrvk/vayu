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
 * Note: `secret` is a UI masking hint — values are NOT encrypted at rest.
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
 * Collections never use `inherit` — they are always the auth source.
 */
export type RequestAuth =
	| { mode: "none" | "inherit" }
	| { mode: "bearer"; token: string }
	| { mode: "basic"; username: string; password: string }
	| { mode: "apikey"; key: string; value: string; in: "header" | "query" }
	| { mode: "oauth2" | "digest" | "aws" | "ntlm"; config: Record<string, unknown> };

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
	bodyType: BodyMode; // Denormalized mirror of body.mode — kept for queryability
	auth: RequestAuth;
	preRequestScript: string;
	postRequestScript: string;
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
 * Note: The `secret` field is a UI hint for masking — values are NOT encrypted at rest.
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

export interface Run {
	id: string;
	type: "load" | "design";
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	endTime: number;
	configSnapshot?: any;
	requestId?: string | null;
	environmentId?: string | null;
}

export interface LoadTestConfig {
	duration_seconds?: number;
	rps?: number;
	concurrency?: number;
	iterations?: number;
	mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up";
	ramp_duration_seconds?: number;
	data_sample_rate?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	comment?: string;
	latency_percentiles?: number[];
}

export interface HttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: any;
	bodyRaw: string;
	bodySize: number;
	timing: {
		total: number;
		dns: number;
		connect: number;
		tls: number;
		firstByte: number;
		download: number;
	};
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
		trace?: {
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
			error_type?: string;
			message?: string;
			headers?: Record<string, string>;
			body?: string;
		};
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

export interface ConfigResponse {
	entries: ConfigEntry[];
	success?: boolean;
}

export type SettingsCategory =
	| "general_engine"
	| "database_performance"
	| "network_performance"
	| "scripting_sandbox"
	| "observability"
	| "ui";

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
