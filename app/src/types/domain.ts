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
	request_id: string;
	environment_id?: string;
	type: "load" | "sanity";
	status: "running" | "completed" | "stopped" | "failed";
	config?: LoadTestConfig;
	started_at: string;
	completed_at?: string;
	total_requests?: number;
	total_errors?: number;
	average_latency_ms?: number;
}

export interface LoadTestConfig {
	duration_seconds?: number;
	rps?: number;
	concurrency?: number;
	iterations?: number;
	mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up";
	ramp_duration_seconds?: number;
	data_sample_rate?: number;
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
	request_id?: string;
	test_results?: TestResult[];
	console_logs?: string[];
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
	run_id: string;
	request: Request;
	environment?: Environment;
	config: LoadTestConfig;
	started_at: string;
	completed_at: string;
	duration_seconds: number;
	total_requests: number;
	total_errors: number;
	success_rate: number;
	avg_latency_ms: number;
	min_latency_ms: number;
	max_latency_ms: number;
	latency_p50_ms: number;
	latency_p95_ms: number;
	latency_p99_ms: number;
	avg_rps: number;
	max_rps: number;
	total_bytes_sent: number;
	total_bytes_received: number;
	status_code_distribution: Record<string, number>;
	error_distribution?: Record<string, number>;
	timeline: LoadTestMetrics[];
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
