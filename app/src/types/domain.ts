// Core Domain Types

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * Variable value with enabled flag (Postman-style)
 */
export interface VariableValue {
	value: string;
	enabled: boolean;
}

export interface Collection {
	id: string;
	name: string;
	description?: string;
	parent_id?: string;
	order?: number; // Position in the collection list
	variables?: Record<string, VariableValue>; // Collection-scoped variables
	created_at: string;
	updated_at: string;
}

export interface Request {
	id: string;
	collection_id: string;
	name: string;
	description?: string;
	method: HttpMethod;
	url: string;
	params?: Record<string, string>; // Query parameters
	headers?: Record<string, string>;
	body?: string;
	body_type?: "json" | "text" | "form-data" | "x-www-form-urlencoded";
	auth?: Record<string, any>;
	pre_request_script?: string;
	test_script?: string;
	created_at: string;
	updated_at: string;
}

export interface Environment {
	id: string;
	name: string;
	variables: Record<string, VariableValue>;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

/**
 * Global variables - singleton storage for app-wide variables
 */
export interface GlobalVariables {
	id: string; // Always "globals"
	variables: Record<string, VariableValue>;
	updated_at: string;
}

/**
 * Variable scope for UI display
 */
export type VariableScope = "global" | "collection" | "environment";

/**
 * Variable info for autocomplete and quick view
 */
export interface VariableInfo {
	name: string;
	value: string;
	scope: VariableScope;
	sourceId?: string; // Collection ID or Environment ID
	sourceName?: string; // Collection name or Environment name
}

export interface Run {
	id: string;
	type: "load" | "design"; // Backend uses "design" not "sanity"
	status: "pending" | "running" | "completed" | "stopped" | "failed";
	startTime: number; // Unix timestamp in ms
	endTime: number;
	configSnapshot?: any; // The request config used for this run
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
	// Data capture options
	data_sample_rate?: number;
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
	// Metadata
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
}

export interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

// SanityResult is the response from /request endpoint
// It directly contains the HTTP response fields
export interface SanityResult extends HttpResponse {
	requestId?: string;
	// Script execution results (camelCase from backend)
	testResults?: TestResult[];
	consoleLogs?: string[];
	// Script errors
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
}

export interface RunReport {
	// Phase 1: Metadata section
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
	// Summary section
	summary: {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		errorRate: number;
		totalDurationSeconds: number;
		avgRps: number;
		// Phase 2: Accurate timing metrics
		testDuration?: number; // Actual test duration in seconds
		setupOverhead?: number; // Context overhead before test started (seconds)
	};
	// Latency section
	latency: {
		min: number;
		max: number;
		avg: number;
		median?: number; // Phase 1: Renamed from p50
		p50: number;
		p75?: number; // Phase 1
		p90: number;
		p95: number;
		p99: number;
		p999?: number; // Phase 1
	};
	// Status code distribution
	statusCodes: Record<string, number>;
	// Error details
	errors: {
		total: number;
		withDetails: number;
		types: Record<string, number>;
		byStatusCode?: Record<string, number>; // Phase 1
	};
	// Phase 1: Rate control metrics
	rateControl?: {
		targetRps: number;
		actualRps: number;
		achievement: number;
	};
	// Optional timing breakdown
	timingBreakdown?: {
		avgDnsMs: number;
		avgConnectMs: number;
		avgTlsMs: number;
		avgFirstByteMs: number;
		avgDownloadMs: number;
	};
	// Optional slow requests info
	slowRequests?: {
		count: number;
		thresholdMs: number;
		percentage: number;
	};
	// Optional test validation results
	testValidation?: {
		samplesTested: number;
		testsPassed: number;
		testsFailed: number;
		successRate: number;
	};
	// Request/Response results (errors + sampled successes)
	// Backend returns this as a direct array
	results?: Array<{
		timestamp: number;
		statusCode: number;
		latencyMs: number;
		error?: string;
		trace?: {
			// Success trace fields (camelCase from backend)
			totalMs?: number;
			dnsMs?: number;
			connectMs?: number;
			tlsMs?: number;
			firstByteMs?: number;
			downloadMs?: number;
			isSlow?: boolean;
			thresholdMs?: number;
			// Error trace fields
			request_number?: number;
			error_code?: number;
			error_type?: string;
			message?: string;
			// Legacy/optional fields
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

/**
 * Configuration entry with metadata for UI display
 */
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
	/** Whether changing this config requires an engine restart */
	requiresRestart?: boolean;
}

/**
 * Configuration response from backend
 */
export interface ConfigResponse {
	entries: ConfigEntry[];
	success?: boolean;
}

/**
 * Settings category for UI grouping
 */
export type SettingsCategory = "server" | "scripting" | "performance" | "ui";

// Script Editor Completions (from backend)
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
