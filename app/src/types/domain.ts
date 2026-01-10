// Core Domain Types

export type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE"
	| "HEAD"
	| "OPTIONS";

export interface Collection {
	id: string;
	name: string;
	description?: string;
	parent_id?: string;
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
	variables: Record<string, string>;
	is_active: boolean;
	created_at: string;
	updated_at: string;
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
	};
	// Latency section
	latency: {
		min: number;
		max: number;
		avg: number;
		median?: number;  // Phase 1: Renamed from p50
		p50: number;
		p75?: number;     // Phase 1
		p90: number;
		p95: number;
		p99: number;
		p999?: number;    // Phase 1
	};
	// Status code distribution
	statusCodes: Record<string, number>;
	// Error details
	errors: {
		total: number;
		withDetails: number;
		types: Record<string, number>;
		byStatusCode?: Record<string, number>;  // Phase 1
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
			headers?: Record<string, string>;
			body?: string;
			dns_ms?: number;
			connect_ms?: number;
			tls_ms?: number;
			first_byte_ms?: number;
			download_ms?: number;
			error_type?: string;
			is_slow?: boolean;
			threshold_ms?: number;
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
