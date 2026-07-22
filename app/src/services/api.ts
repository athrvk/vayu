/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// API Service Layer - All backend endpoints

import { httpClient } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import {
	RequestTransformer,
	CollectionTransformer,
	RunReportTransformer,
	GlobalsTransformer,
} from "./transformers";
import type {
	Collection,
	Request,
	Environment,
	GlobalVariables,
	VariableValue,
	Run,
	RunReport,
	EngineHealth,
	SanityResult,
	ScriptCompletionsResponse,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	ListRequestsParams,
	CreateRequestRequest,
	UpdateRequestRequest,
	CreateEnvironmentRequest,
	UpdateEnvironmentRequest,
	ExecuteRequestRequest,
	StartLoadTestRequest,
	StartLoadTestResponse,
	GetRunReportResponse,
	StopRunResponse,
	GetHealthResponse,
	GetConfigResponse,
	UpdateConfigRequest,
	GlobalsResponse,
	ImportFetchResponse,
	OAuth2TokenRequest,
	OAuth2TokenResponse,
	OAuth2TokenStatusResponse,
	OAuth2AuthorizeStartRequest,
	OAuth2AuthorizeStartResponse,
	OAuth2AuthorizeStatusResponse,
} from "@/types";
import type { TimeSeriesResponse } from "@/modules/history/types";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import {
	PROXIED_TIMEOUT_GRACE_MS,
	ENGINE_MAX_DEFAULT_TIMEOUT_MS,
	STATS_PAGE_LIMIT,
} from "@/config/network";

/**
 * Timeout for engine calls that proxy a remote server (/request,
 * /import/fetch). These block for as long as the target takes, bounded by the
 * engine's user-configurable `defaultTimeout` setting - so derive the UI
 * timeout from it instead of the flat default, with enough grace that the
 * engine's own TIMEOUT error (proper error code) arrives before the UI aborts.
 * Falls back to the engine's max when the config cache is cold. If per-request
 * timeout overrides are ever added, this must become max(default, override).
 */
function proxiedRequestTimeoutMs(): number {
	const config = queryClient.getQueryData<GetConfigResponse>(queryKeys.config.all);
	const engineTimeout = Number(config?.entries.find((e) => e.key === "defaultTimeout")?.value);
	const base =
		Number.isFinite(engineTimeout) && engineTimeout > 0
			? engineTimeout
			: ENGINE_MAX_DEFAULT_TIMEOUT_MS;
	return base + PROXIED_TIMEOUT_GRACE_MS;
}

export const apiService = {
	// Health & Configuration
	async getHealth(): Promise<EngineHealth> {
		const response = await httpClient.get<GetHealthResponse>(API_ENDPOINTS.HEALTH);
		return response;
	},

	async getConfig(): Promise<GetConfigResponse> {
		const response = await httpClient.get<GetConfigResponse>(API_ENDPOINTS.CONFIG);
		return response;
	},

	async updateConfig(config: UpdateConfigRequest): Promise<GetConfigResponse> {
		return await httpClient.post<GetConfigResponse>(API_ENDPOINTS.CONFIG, config);
	},

	// Collections
	async listCollections(): Promise<Collection[]> {
		console.log("API: Fetching collections from", API_ENDPOINTS.COLLECTIONS);
		const response = await httpClient.get<any[]>(API_ENDPOINTS.COLLECTIONS);
		console.log("API: Received collections:", response);
		return response.map(CollectionTransformer.toFrontend);
	},

	async createCollection(data: CreateCollectionRequest): Promise<Collection> {
		const response = await httpClient.post<any>(API_ENDPOINTS.COLLECTIONS, data);
		return CollectionTransformer.toFrontend(response);
	},

	async updateCollection(data: UpdateCollectionRequest): Promise<Collection> {
		const response = await httpClient.post<any>(API_ENDPOINTS.COLLECTIONS, data);
		return CollectionTransformer.toFrontend(response);
	},

	async deleteCollection(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.COLLECTION_BY_ID(id));
	},

	// Requests
	async listRequests(params?: ListRequestsParams): Promise<Request[]> {
		const queryParams = params?.collectionId
			? { collectionId: params.collectionId }
			: undefined;
		console.log("API: Fetching requests from", API_ENDPOINTS.REQUESTS, queryParams);
		const response = await httpClient.get<Request[]>(API_ENDPOINTS.REQUESTS, queryParams);
		console.log("API: Received requests:", response);
		return response.map(RequestTransformer.toFrontend);
	},

	async getRequest(id: string): Promise<Request> {
		console.log("API: Fetching request from", API_ENDPOINTS.REQUEST_BY_ID(id));
		const response = await httpClient.get<Request>(API_ENDPOINTS.REQUEST_BY_ID(id));
		console.log("API: Received request:", response);
		return RequestTransformer.toFrontend(response);
	},

	async createRequest(data: CreateRequestRequest): Promise<Request> {
		console.log("Creating request with data:", data);
		const response = await httpClient.post<Request>(API_ENDPOINTS.REQUESTS, data);
		return RequestTransformer.toFrontend(response);
	},

	async updateRequest(data: UpdateRequestRequest): Promise<Request> {
		console.log("Updating request with data:", data);
		const response = await httpClient.post<Request>(API_ENDPOINTS.REQUESTS, data);
		return RequestTransformer.toFrontend(response);
	},

	async deleteRequest(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.REQUEST_BY_ID(id));
	},

	// Environments
	async listEnvironments(): Promise<Environment[]> {
		// Backend returns flat array directly
		return await httpClient.get<Environment[]>(API_ENDPOINTS.ENVIRONMENTS);
	},

	async getEnvironment(id: string): Promise<Environment> {
		return await httpClient.get<Environment>(API_ENDPOINTS.ENVIRONMENT_BY_ID(id));
	},

	async createEnvironment(data: CreateEnvironmentRequest): Promise<Environment> {
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, data);
	},

	async updateEnvironment(data: UpdateEnvironmentRequest): Promise<Environment> {
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, data);
	},

	async deleteEnvironment(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.ENVIRONMENT_BY_ID(id));
	},

	// Global Variables
	async getGlobals(): Promise<GlobalVariables> {
		const response = await httpClient.get<GlobalsResponse>(API_ENDPOINTS.GLOBALS);
		return GlobalsTransformer.toFrontend(response);
	},

	async updateGlobals(variables: Record<string, VariableValue>): Promise<GlobalVariables> {
		const response = await httpClient.post<GlobalsResponse>(API_ENDPOINTS.GLOBALS, {
			variables,
		});
		return GlobalsTransformer.toFrontend(response);
	},

	// Execution
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<SanityResult>(API_ENDPOINTS.EXECUTE_REQUEST, data, {
			timeout: proxiedRequestTimeoutMs(),
		});
	},

	async startLoadTest(data: StartLoadTestRequest): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(API_ENDPOINTS.START_LOAD_TEST, data);
	},

	// Run Management
	async listRuns(): Promise<Run[]> {
		// Backend returns flat array directly
		return await httpClient.get<Run[]>(API_ENDPOINTS.RUNS);
	},

	async getRun(id: string): Promise<Run> {
		// Backend returns run object directly
		return await httpClient.get<Run>(API_ENDPOINTS.RUN_BY_ID(id));
	},

	async getRunReport(id: string): Promise<RunReport> {
		const response = await httpClient.get<GetRunReportResponse>(API_ENDPOINTS.RUN_REPORT(id));
		return RunReportTransformer.toFrontend(response);
	},

	async stopRun(id: string): Promise<StopRunResponse> {
		return await httpClient.post<StopRunResponse>(API_ENDPOINTS.RUN_STOP(id));
	},

	async deleteRun(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.RUN_BY_ID(id));
	},

	/**
	 * Get time-series metrics for a run (paginated)
	 * Used for rendering historical charts
	 */
	async getRunTimeSeries(
		id: string,
		options: { limit?: number; offset?: number } = {}
	): Promise<TimeSeriesResponse> {
		const { limit = STATS_PAGE_LIMIT, offset = 0 } = options;
		return await httpClient.get<TimeSeriesResponse>(
			API_ENDPOINTS.STATS_TIME_SERIES(id, limit, offset)
		);
	},

	// Scripting
	async getScriptCompletions(): Promise<ScriptCompletionsResponse> {
		return await httpClient.get<ScriptCompletionsResponse>(API_ENDPOINTS.SCRIPT_COMPLETIONS);
	},

	// Import
	async importFetch(url: string): Promise<ImportFetchResponse> {
		return await httpClient.post<ImportFetchResponse>(
			API_ENDPOINTS.IMPORT_FETCH,
			{ url },
			{ timeout: proxiedRequestTimeoutMs() }
		);
	},

	// OAuth 2.0 - the engine proxies the token endpoint, so use the longer
	// proxied timeout (as with executeRequest / importFetch).
	async fetchOAuth2Token(data: OAuth2TokenRequest): Promise<OAuth2TokenResponse> {
		return await httpClient.post<OAuth2TokenResponse>(API_ENDPOINTS.OAUTH2_TOKEN, data, {
			timeout: proxiedRequestTimeoutMs(),
		});
	},

	async getOAuth2TokenStatus(cacheKey: string): Promise<OAuth2TokenStatusResponse> {
		return await httpClient.get<OAuth2TokenStatusResponse>(API_ENDPOINTS.OAUTH2_TOKEN, {
			key: cacheKey,
		});
	},

	async clearOAuth2Token(cacheKey: string): Promise<void> {
		await httpClient.delete<{ deleted: boolean }>(API_ENDPOINTS.OAUTH2_TOKEN, {
			key: cacheKey,
		});
	},

	async startOAuth2Authorize(
		data: OAuth2AuthorizeStartRequest
	): Promise<OAuth2AuthorizeStartResponse> {
		return await httpClient.post<OAuth2AuthorizeStartResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_START,
			data
		);
	},

	async completeOAuth2Authorize(
		attemptId: string,
		callbackUrl: string
	): Promise<OAuth2AuthorizeStatusResponse> {
		return await httpClient.post<OAuth2AuthorizeStatusResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_COMPLETE,
			{ attemptId, callbackUrl }
		);
	},

	async getOAuth2AuthorizeStatus(attemptId: string): Promise<OAuth2AuthorizeStatusResponse> {
		return await httpClient.get<OAuth2AuthorizeStatusResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_STATUS(attemptId)
		);
	},
};
