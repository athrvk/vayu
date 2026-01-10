// API Service Layer - All backend endpoints

import { httpClient } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import type {
	Collection,
	Request,
	Environment,
	Run,
	RunReport,
	EngineHealth,
	EngineConfig,
	SanityResult,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	ListRequestsParams,
	CreateRequestRequest,
	UpdateRequestRequest,
	ListEnvironmentsResponse,
	CreateEnvironmentRequest,
	UpdateEnvironmentRequest,
	ExecuteRequestRequest,
	ExecuteRequestResponse,
	StartLoadTestRequest,
	StartLoadTestResponse,
	ListRunsParams,
	ListRunsResponse,
	GetRunResponse,
	GetRunReportResponse,
	StopRunResponse,
	GetHealthResponse,
	GetConfigResponse,
	UpdateConfigRequest,
} from "@/types";

export const apiService = {
	// Health & Configuration
	async getHealth(): Promise<EngineHealth> {
		const response = await httpClient.get<GetHealthResponse>(
			API_ENDPOINTS.HEALTH
		);
		return response;
	},

	async getConfig(): Promise<EngineConfig> {
		const response = await httpClient.get<GetConfigResponse>(
			API_ENDPOINTS.CONFIG
		);
		return response;
	},

	async updateConfig(config: UpdateConfigRequest): Promise<EngineConfig> {
		return await httpClient.post<EngineConfig>(API_ENDPOINTS.CONFIG, config);
	},

	// Collections
	async listCollections(): Promise<Collection[]> {
		console.log("API: Fetching collections from", API_ENDPOINTS.COLLECTIONS);
		const response = await httpClient.get<Collection[]>(
			API_ENDPOINTS.COLLECTIONS
		);
		console.log("API: Received collections:", response);
		return response;
	},

	async createCollection(data: CreateCollectionRequest): Promise<Collection> {
		return await httpClient.post<Collection>(API_ENDPOINTS.COLLECTIONS, data);
	},

	async updateCollection(data: UpdateCollectionRequest): Promise<Collection> {
		return await httpClient.post<Collection>(API_ENDPOINTS.COLLECTIONS, data);
	},

	async deleteCollection(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.COLLECTION_BY_ID(id));
	},

	// Requests
	async listRequests(params?: ListRequestsParams): Promise<Request[]> {
		const queryParams = params?.collection_id
			? { collectionId: params.collection_id }
			: undefined;
		const response = await httpClient.get<Request[]>(
			API_ENDPOINTS.REQUESTS,
			queryParams
		);
		return response;
	},

	async getRequest(id: string): Promise<Request> {
		return await httpClient.get<Request>(API_ENDPOINTS.REQUEST_BY_ID(id));
	},

	async createRequest(data: CreateRequestRequest): Promise<Request> {
		// Transform snake_case to camelCase for backend
		const backendData: any = {
			collectionId: data.collection_id,
			name: data.name,
			method: data.method,
			url: data.url,
		};

		// Only include optional fields if they exist
		if (data.headers) backendData.headers = data.headers;
		if (data.body) backendData.body = data.body;
		if (data.auth) backendData.auth = data.auth;
		if (data.pre_request_script)
			backendData.preRequestScript = data.pre_request_script;
		if (data.test_script) backendData.postRequestScript = data.test_script;

		console.log("Creating request with data:", backendData);
		return await httpClient.post<Request>(API_ENDPOINTS.REQUESTS, backendData);
	},

	async updateRequest(data: UpdateRequestRequest): Promise<Request> {
		// Transform snake_case to camelCase for backend
		const backendData: any = {
			id: data.id,
			name: data.name,
			method: data.method,
			url: data.url,
		};

		// Optional fields - only include if they're present
		if (data.headers !== undefined) backendData.headers = data.headers;
		if (data.body !== undefined) backendData.body = data.body;
		if (data.auth !== undefined) backendData.auth = data.auth;
		if (data.pre_request_script !== undefined)
			backendData.preRequestScript = data.pre_request_script;
		if (data.test_script !== undefined) backendData.postRequestScript = data.test_script;
		if (data.description !== undefined) backendData.description = data.description;
		if (data.body_type !== undefined) backendData.bodyType = data.body_type;

		console.log("Updating request with data:", backendData);
		return await httpClient.post<Request>(API_ENDPOINTS.REQUESTS, backendData);
	},

	async deleteRequest(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.REQUEST_BY_ID(id));
	},

	// Environments
	async listEnvironments(): Promise<Environment[]> {
		const response = await httpClient.get<ListEnvironmentsResponse>(
			API_ENDPOINTS.ENVIRONMENTS
		);
		return response.environments;
	},

	async getEnvironment(id: string): Promise<Environment> {
		return await httpClient.get<Environment>(
			API_ENDPOINTS.ENVIRONMENT_BY_ID(id)
		);
	},

	async createEnvironment(
		data: CreateEnvironmentRequest
	): Promise<Environment> {
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, data);
	},

	async updateEnvironment(
		data: UpdateEnvironmentRequest
	): Promise<Environment> {
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, data);
	},

	async deleteEnvironment(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.ENVIRONMENT_BY_ID(id));
	},

	// Execution
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<ExecuteRequestResponse>(
			API_ENDPOINTS.EXECUTE_REQUEST,
			data
		);
	},

	async startLoadTest(
		data: StartLoadTestRequest
	): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(
			API_ENDPOINTS.START_LOAD_TEST,
			data
		);
	},

	// Run Management
	async listRuns(
		params?: ListRunsParams
	): Promise<{ runs: Run[]; total: number }> {
		const queryParams: Record<string, string> = {};
		if (params?.request_id) queryParams.request_id = params.request_id;
		if (params?.type) queryParams.type = params.type;
		if (params?.status) queryParams.status = params.status;
		if (params?.limit) queryParams.limit = params.limit.toString();
		if (params?.offset) queryParams.offset = params.offset.toString();

		return await httpClient.get<ListRunsResponse>(
			API_ENDPOINTS.RUNS,
			queryParams
		);
	},

	async getRun(id: string): Promise<Run> {
		const response = await httpClient.get<GetRunResponse>(
			API_ENDPOINTS.RUN_BY_ID(id)
		);
		return response.run;
	},

	async getRunReport(id: string): Promise<RunReport> {
		return await httpClient.get<GetRunReportResponse>(
			API_ENDPOINTS.RUN_REPORT(id)
		);
	},

	async stopRun(id: string): Promise<StopRunResponse> {
		return await httpClient.post<StopRunResponse>(API_ENDPOINTS.RUN_STOP(id));
	},

	async deleteRun(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.RUN_BY_ID(id));
	},
};
