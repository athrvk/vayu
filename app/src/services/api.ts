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
	type RawCollection,
	type RawRequest,
} from "./transformers";
import type {
	Collection,
	Request,
	Environment,
	GlobalVariables,
	VariableValue,
	Run,
	RunListResponse,
	RunListParams,
	RunReport,
	RunSamplesResponse,
	EngineHealth,
	SanityResult,
	ScriptCompletionsResponse,
	ScriptTypeDefinitionsResponse,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	ListRequestsParams,
	CreateRequestRequest,
	UpdateRequestRequest,
	CreateEnvironmentRequest,
	UpdateEnvironmentRequest,
	ComposeRequestRequest,
	ComposedRequest,
	ExecuteRequestRequest,
	StartLoadTestRequest,
	StartLoadTestResponse,
	GetRunReportResponse,
	StopRunResponse,
	GetHealthResponse,
	GetCookiesResponse,
	ClearCookiesResponse,
	GetConfigResponse,
	UpdateConfigRequest,
	GlobalsResponse,
	ImportFetchResponse,
	ImportApplyRequest,
	ImportApplyResponse,
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
	RUN_SAMPLES_PAGE_LIMIT,
	RUNS_PAGE_LIMIT,
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

/**
 * Drop `id` from a create payload before it is sent.
 *
 * Since #97 the engine assigns every id and answers a create carrying one with a
 * `400`, so this is the difference between a save working and failing, not
 * cosmetics. The `Create*Request` types already have no `id`, but that is not a
 * guarantee: excess-property checking only fires on object literals, so a call
 * site that spreads a whole record (a duplicate flow, a restored tab, a
 * transformer output) passes one through unnoticed. Stripping it in the one
 * place every create goes through makes the payload correct by construction
 * rather than by review of each new call site.
 */
function withoutId<T extends object>(data: T): Omit<T, "id"> {
	const { id: _engineAssigned, ...rest } = data as T & { id?: unknown };
	return rest;
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
		const response = await httpClient.get<RawCollection[]>(API_ENDPOINTS.COLLECTIONS);
		console.log("API: Received collections:", response);
		return response.map(CollectionTransformer.toFrontend);
	},

	async createCollection(data: CreateCollectionRequest): Promise<Collection> {
		const response = await httpClient.post<RawCollection>(
			API_ENDPOINTS.COLLECTIONS,
			withoutId(data)
		);
		return CollectionTransformer.toFrontend(response);
	},

	async updateCollection(data: UpdateCollectionRequest): Promise<Collection> {
		// PUT, not POST: since #95 the engine's POST is create-only and answers a
		// known id with 409. The id travels in the path (it is the identity);
		// the rest of the object is a merge-patch, where an omitted field keeps
		// its stored value and an explicit null resets it to the default.
		const { id, ...patch } = data;
		const response = await httpClient.put<RawCollection>(
			API_ENDPOINTS.COLLECTIONS_UPDATE(id),
			patch
		);
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
		const response = await httpClient.get<RawRequest[]>(API_ENDPOINTS.REQUESTS, queryParams);
		console.log("API: Received requests:", response);
		return response.map(RequestTransformer.toFrontend);
	},

	async getRequest(id: string): Promise<Request> {
		console.log("API: Fetching request from", API_ENDPOINTS.REQUEST_BY_ID(id));
		const response = await httpClient.get<RawRequest>(API_ENDPOINTS.REQUEST_BY_ID(id));
		console.log("API: Received request:", response);
		return RequestTransformer.toFrontend(response);
	},

	async createRequest(data: CreateRequestRequest): Promise<Request> {
		console.log("Creating request with data:", data);
		const response = await httpClient.post<RawRequest>(API_ENDPOINTS.REQUESTS, withoutId(data));
		return RequestTransformer.toFrontend(response);
	},

	async updateRequest(data: UpdateRequestRequest): Promise<Request> {
		// PUT, not POST - see updateCollection above for why.
		const { id, ...patch } = data;
		const response = await httpClient.put<RawRequest>(API_ENDPOINTS.REQUESTS_UPDATE(id), patch);
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
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, withoutId(data));
	},

	async updateEnvironment(data: UpdateEnvironmentRequest): Promise<Environment> {
		// PUT, not POST - see updateCollection above for why.
		const { id, ...patch } = data;
		return await httpClient.put<Environment>(API_ENDPOINTS.ENVIRONMENTS_UPDATE(id), patch);
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

	// Cookie jar (issue #301)
	async getCookies(): Promise<GetCookiesResponse> {
		return await httpClient.get<GetCookiesResponse>(API_ENDPOINTS.COOKIES);
	},

	/**
	 * Clear one jar, or every jar.
	 *
	 * The parameter distinguishes three cases the way the engine does: omitted
	 * clears everything, `null` clears the jar used when no environment is
	 * selected, and an id clears that environment's. Passing `null` and passing
	 * nothing are therefore *not* the same call: one reaches the engine with
	 * the parameter present and empty, the other with no parameter at all.
	 */
	async clearCookies(scope?: { environmentId: string | null }): Promise<ClearCookiesResponse> {
		return await httpClient.delete<ClearCookiesResponse>(
			API_ENDPOINTS.COOKIES,
			scope === undefined ? undefined : { environmentId: scope.environmentId ?? "" }
		);
	},

	// Execution
	/**
	 * Compose a request engine-side (`POST /compose`): `{{variables}}` and
	 * `inherit` auth resolved, execute-ready payload back. Pure - nothing is
	 * sent - and `/execute` / `/runs` never interpolate, so composing here and
	 * executing the result resolves everything exactly once (issue #226).
	 */
	async composeRequest(data: ComposeRequestRequest): Promise<ComposedRequest> {
		return await httpClient.post<ComposedRequest>(API_ENDPOINTS.COMPOSE_REQUEST, data);
	},

	/**
	 * `allowScriptRequests` opts this execution's scripts into `pm.sendRequest`
	 * (issue #302). The engine denies it unless asked, because Vayu's MCP target
	 * allowlist is checked in the MCP server *before* it calls the engine - a
	 * request issued from inside a script never passes that gate. The renderer
	 * is the surface whose scripts the user wrote, so it asks; the MCP server
	 * never does, and an agent cannot smuggle the field in because every MCP
	 * tool builds its request from named arguments.
	 *
	 * Set here rather than at each call site, so a new caller cannot forget it
	 * and quietly lose the feature - the same single-choke-point reason
	 * `httpVersion` and the redirect policy are sent on every execute rather
	 * than elided when they match a default.
	 */
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<SanityResult>(
			API_ENDPOINTS.EXECUTE_REQUEST,
			{ ...data, allowScriptRequests: true },
			{ timeout: proxiedRequestTimeoutMs() }
		);
	},

	/** A run's `tests` script is the same script Send runs - see executeRequest. */

	async startLoadTest(data: StartLoadTestRequest): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(API_ENDPOINTS.START_LOAD_TEST, {
			...data,
			allowScriptRequests: true,
		});
	},

	// Run Management
	/**
	 * List runs, newest first, as a `{data, pagination}` envelope. Passing
	 * pagination/filter params opts into the envelope; the history sidebar polls
	 * the first page and pages older runs in on demand.
	 */
	async listRuns(params: RunListParams = {}): Promise<RunListResponse> {
		const { limit = RUNS_PAGE_LIMIT, offset = 0, type, status, requestId, q } = params;
		return await httpClient.get<RunListResponse>(
			API_ENDPOINTS.RUNS_LIST({ limit, offset, type, status, requestId, q })
		);
	},

	/**
	 * Fetch every run matching @p params by paging to exhaustion. For callers
	 * that genuinely need the whole set (clearing all history, counting) rather
	 * than a polled page. Rows still carry the compact `summary`, so this stays
	 * cheap even over a large history.
	 */
	async listAllRuns(params: Omit<RunListParams, "limit" | "offset"> = {}): Promise<Run[]> {
		const limit = 500; // Engine's max page size.
		const all: Run[] = [];
		let offset = 0;
		// Bounded by pagination.hasMore; the engine caps limit at 500.
		for (;;) {
			const page = await this.listRuns({ ...params, limit, offset });
			all.push(...page.data);
			if (!page.pagination.hasMore) break;
			offset += page.pagination.limit;
		}
		return all;
	},

	async getRun(id: string): Promise<Run> {
		// Backend returns run object directly
		return await httpClient.get<Run>(API_ENDPOINTS.RUN_BY_ID(id));
	},

	async getRunReport(id: string): Promise<RunReport> {
		const response = await httpClient.get<GetRunReportResponse>(API_ENDPOINTS.RUN_REPORT(id));
		return RunReportTransformer.toFrontend(response);
	},

	/**
	 * The response headers and body captured for a run's retained samples -
	 * every error, the slow outliers, and the first few of each status code.
	 *
	 * Its own request rather than fields on the report: the report path loads
	 * and parses every result row for a run on each fetch, and the dashboard
	 * polls it. Join a page's `resultId` against `report.results[].id`.
	 */
	async getRunSamples(
		id: string,
		options: { limit?: number; offset?: number } = {}
	): Promise<RunSamplesResponse> {
		const { limit = RUN_SAMPLES_PAGE_LIMIT, offset = 0 } = options;
		return await httpClient.get<RunSamplesResponse>(
			API_ENDPOINTS.RUN_SAMPLES(id, limit, offset)
		);
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

	async getScriptTypeDefinitions(): Promise<ScriptTypeDefinitionsResponse> {
		return await httpClient.get<ScriptTypeDefinitionsResponse>(API_ENDPOINTS.SCRIPT_TYPES);
	},

	// Import
	async importFetch(url: string): Promise<ImportFetchResponse> {
		return await httpClient.post<ImportFetchResponse>(
			API_ENDPOINTS.IMPORT_FETCH,
			{ url },
			{ timeout: proxiedRequestTimeoutMs() }
		);
	},

	/**
	 * Persist a whole parsed import in one call. All-or-nothing: a rejected
	 * payload wrote nothing, so there is no partial tree to clean up. The engine
	 * owns every id here and returns the temp-id -> real-id map.
	 */
	async applyImport(payload: ImportApplyRequest): Promise<ImportApplyResponse> {
		return await httpClient.post<ImportApplyResponse>(API_ENDPOINTS.IMPORT_APPLY, payload);
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
