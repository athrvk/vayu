
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
} from "./domain";

// API Response wrapper
export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
}

// Collections API
export interface ListCollectionsResponse {
	collections: Collection[];
}

export interface CreateCollectionRequest {
	name: string;
	description?: string;
	parentId?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
}

export interface UpdateCollectionRequest {
	id: string;
	name?: string;
	description?: string;
	parentId?: string;
	order?: number;
	variables?: Record<string, VariableValue>;
}

// Requests API
export interface ListRequestsParams {
	collectionId?: string;
}

export interface ListRequestsResponse {
	requests: Request[];
}

export interface CreateRequestRequest {
	collectionId: string;
	name: string;
	description?: string;
	method: string;
	url: string;
	params?: Record<string, string>;
	headers?: Record<string, string>;
	body?: string;
	bodyType?: string;
	auth?: Record<string, any>;
	preRequestScript?: string;
	postRequestScript?: string;
}

export interface UpdateRequestRequest {
	id: string;
	name?: string;
	description?: string;
	method?: string;
	url?: string;
	params?: Record<string, string>;
	headers?: Record<string, string>;
	body?: string;
	bodyType?: string;
	auth?: Record<string, any>;
	preRequestScript?: string;
	postRequestScript?: string;
}

// Environments API
export interface ListEnvironmentsResponse {
	environments: Environment[];
}

export interface CreateEnvironmentRequest {
	name: string;
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
	// Required HTTP request fields
	method: string;
	url: string;

	// Optional HTTP request fields
	headers?: Record<string, string>;
	body?: any;
	auth?: Record<string, any>;

	// Scripts
	preRequestScript?: string;
	postRequestScript?: string;

	// Optional linking fields (camelCase as per API docs)
	requestId?: string;
	environmentId?: string;
}

export interface ExecuteRequestResponse extends SanityResult {}

/**
 * StartLoadTestRequest - Matches POST /run backend endpoint
 * The backend expects a flat structure with:
 * - HTTP request fields (method, url, headers, body) at root level
 * - mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up"
 * - Mode-specific params (duration, targetRps, iterations, concurrency, etc.)
 */
export interface StartLoadTestRequest {
	// HTTP request fields (same structure as ExecuteRequestRequest)
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: any;

	// Load test strategy
	mode: "constant_rps" | "constant_concurrency" | "iterations" | "ramp_up";

	// For constant_rps / constant_concurrency modes
	duration?: string; // e.g., "10s", "2m"
	targetRps?: number;

	// For "iterations" mode
	iterations?: number;
	concurrency?: number;

	// For "ramp_up" mode
	rampUpDuration?: string;
	startConcurrency?: number;

	// Optional linking
	requestId?: string;
	environmentId?: string;
	comment?: string;

	// Data capture options
	success_sample_rate?: number; // 0-100
	slow_threshold_ms?: number;
	save_timing_breakdown?: boolean;
}

export interface StartLoadTestResponse {
	runId: string;
	status: string;
	message?: string;
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

export interface GetRunReportResponse extends RunReport {}

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

// Health & Config API
export interface GetHealthResponse extends EngineHealth {}

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
