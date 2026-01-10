// API Request/Response Types

import type {
	Collection,
	Request,
	Environment,
	Run,
	LoadTestConfig,
	SanityResult,
	RunReport,
	EngineHealth,
	EngineConfig,
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
	parent_id?: string;
}

export interface UpdateCollectionRequest {
	id: string;
	name?: string;
	description?: string;
	parent_id?: string;
}

// Requests API
export interface ListRequestsParams {
	collection_id?: string;
}

export interface ListRequestsResponse {
	requests: Request[];
}

export interface CreateRequestRequest {
	collection_id: string;
	name: string;
	description?: string;
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	body_type?: string;
	auth?: Record<string, any>;
	pre_request_script?: string;
	test_script?: string;
}

export interface UpdateRequestRequest {
	id: string;
	name?: string;
	description?: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: string;
	body_type?: string;
	auth?: Record<string, any>;
	pre_request_script?: string;
	test_script?: string;
}

// Environments API
export interface ListEnvironmentsResponse {
	environments: Environment[];
}

export interface CreateEnvironmentRequest {
	name: string;
	variables: Record<string, string>;
	is_active?: boolean;
}

export interface UpdateEnvironmentRequest {
	id: string;
	name?: string;
	variables?: Record<string, string>;
	is_active?: boolean;
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

export interface StartLoadTestRequest {
	request_id: string;
	environment_id?: string;
	config: LoadTestConfig;
}

export interface StartLoadTestResponse {
	run_id: string;
	status: string;
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
	run_id: string;
	status: string;
}

// Health & Config API
export interface GetHealthResponse extends EngineHealth {}

export interface GetConfigResponse extends EngineConfig {}

export interface UpdateConfigRequest {
	max_concurrency?: number;
	default_timeout_ms?: number;
	follow_redirects?: boolean;
	verify_ssl?: boolean;
}
