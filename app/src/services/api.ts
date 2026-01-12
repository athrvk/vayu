// API Service Layer - All backend endpoints

import { httpClient } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import type {
	Collection,
	Request,
	Environment,
	GlobalVariables,
	VariableValue,
	Run,
	RunReport,
	EngineHealth,
	EngineConfig,
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
} from "@/types";

// Transform backend request (camelCase) to frontend request (snake_case)
function transformRequest(backendRequest: any): Request {
	return {
		...backendRequest,
		collection_id: backendRequest.collectionId,
		created_at: backendRequest.createdAt || backendRequest.created_at,
		updated_at: backendRequest.updatedAt || backendRequest.updated_at,
		body_type: backendRequest.bodyType || backendRequest.body_type,
		pre_request_script: backendRequest.preRequestScript || backendRequest.pre_request_script,
		test_script: backendRequest.postRequestScript || backendRequest.test_script,
		// Params is already in snake_case from backend, but ensure it's set
		params: backendRequest.params || {},
	};
}

// Transform backend collection (camelCase) to frontend collection (snake_case)
function transformCollection(backendCollection: any): Collection {
	return {
		...backendCollection,
		parent_id: backendCollection.parentId || backendCollection.parent_id,
		created_at: backendCollection.createdAt || backendCollection.created_at,
		updated_at: backendCollection.updatedAt || backendCollection.updated_at,
	};
}

// Transform backend RunReport - handles statusCodes array format to object
function transformRunReport(backendReport: any): RunReport {
	const report = { ...backendReport };
	
	// Backend returns statusCodes as array of tuples: [[200, 50], [404, 10]]
	// Frontend expects: { "200": 50, "404": 10 }
	if (Array.isArray(report.statusCodes)) {
		const statusCodesObj: Record<string, number> = {};
		for (const entry of report.statusCodes) {
			if (Array.isArray(entry) && entry.length >= 2) {
				statusCodesObj[String(entry[0])] = entry[1];
			}
		}
		report.statusCodes = statusCodesObj;
	}
	
	// Also transform errors.byStatusCode if present
	if (report.errors && Array.isArray(report.errors.byStatusCode)) {
		const byStatusCodeObj: Record<string, number> = {};
		for (const entry of report.errors.byStatusCode) {
			if (Array.isArray(entry) && entry.length >= 2) {
				byStatusCodeObj[String(entry[0])] = entry[1];
			}
		}
		report.errors.byStatusCode = byStatusCodeObj;
	}
	
	return report as RunReport;
}

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
		const response = await httpClient.get<any[]>(
			API_ENDPOINTS.COLLECTIONS
		);
		console.log("API: Received collections:", response);
		return response.map(transformCollection);
	},

	async createCollection(data: CreateCollectionRequest): Promise<Collection> {
		// Transform snake_case to camelCase for backend
		const backendData: any = {
			name: data.name,
			description: data.description,
		};
		if (data.parent_id) {
			backendData.parentId = data.parent_id;
		}
		const response = await httpClient.post<any>(API_ENDPOINTS.COLLECTIONS, backendData);
		return transformCollection(response);
	},

	async updateCollection(data: UpdateCollectionRequest): Promise<Collection> {
		// Transform snake_case to camelCase for backend
		const backendData: any = {
			id: data.id,
			name: data.name,
			description: data.description,
		};
		if (data.parent_id) {
			backendData.parentId = data.parent_id;
		}
		if (data.variables) {
			backendData.variables = data.variables;
		}
		const response = await httpClient.post<any>(API_ENDPOINTS.COLLECTIONS, backendData);
		return transformCollection(response);
	},

	async deleteCollection(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.COLLECTION_BY_ID(id));
	},

	// Requests
	async listRequests(params?: ListRequestsParams): Promise<Request[]> {
		const queryParams = params?.collection_id
			? { collectionId: params.collection_id }
			: undefined;
		const response = await httpClient.get<any[]>(
			API_ENDPOINTS.REQUESTS,
			queryParams
		);
		return response.map(transformRequest);
	},

	async getRequest(id: string): Promise<Request> {
		const response = await httpClient.get<any>(API_ENDPOINTS.REQUEST_BY_ID(id));
		return transformRequest(response);
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
		if (data.params) backendData.params = data.params;
		if (data.body) backendData.body = data.body;
		if (data.body_type) backendData.bodyType = data.body_type;
		if (data.auth) backendData.auth = data.auth;
		if (data.pre_request_script)
			backendData.preRequestScript = data.pre_request_script;
		if (data.test_script) backendData.postRequestScript = data.test_script;

		console.log("Creating request with data:", backendData);
		const response = await httpClient.post<any>(API_ENDPOINTS.REQUESTS, backendData);
		return transformRequest(response);
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
		if (data.params !== undefined) backendData.params = data.params;
		if (data.body !== undefined) backendData.body = data.body;
		if (data.body_type !== undefined) backendData.bodyType = data.body_type;
		if (data.auth !== undefined) backendData.auth = data.auth;
		if (data.pre_request_script !== undefined)
			backendData.preRequestScript = data.pre_request_script;
		if (data.test_script !== undefined) backendData.postRequestScript = data.test_script;
		if (data.description !== undefined) backendData.description = data.description;

		console.log("Updating request with data:", backendData);
		const response = await httpClient.post<any>(API_ENDPOINTS.REQUESTS, backendData);
		return transformRequest(response);
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

	// Global Variables
	async getGlobals(): Promise<GlobalVariables> {
		const response = await httpClient.get<{
			id: string;
			variables: Record<string, VariableValue>;
			updatedAt: number;
		}>(API_ENDPOINTS.GLOBALS);
		return {
			id: response.id,
			variables: response.variables || {},
			updated_at: new Date(response.updatedAt).toISOString(),
		};
	},

	async updateGlobals(variables: Record<string, VariableValue>): Promise<GlobalVariables> {
		const response = await httpClient.post<{
			id: string;
			variables: Record<string, VariableValue>;
			updatedAt: number;
		}>(API_ENDPOINTS.GLOBALS, { variables });
		return {
			id: response.id,
			variables: response.variables || {},
			updated_at: new Date(response.updatedAt).toISOString(),
		};
	},

	// Execution
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<SanityResult>(
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
	async listRuns(): Promise<Run[]> {
		// Backend returns flat array directly
		return await httpClient.get<Run[]>(API_ENDPOINTS.RUNS);
	},

	async getRun(id: string): Promise<Run> {
		// Backend returns run object directly
		return await httpClient.get<Run>(API_ENDPOINTS.RUN_BY_ID(id));
	},

	async getRunReport(id: string): Promise<RunReport> {
		const response = await httpClient.get<GetRunReportResponse>(
			API_ENDPOINTS.RUN_REPORT(id)
		);
		return transformRunReport(response);
	},

	async stopRun(id: string): Promise<StopRunResponse> {
		return await httpClient.post<StopRunResponse>(API_ENDPOINTS.RUN_STOP(id));
	},

	async deleteRun(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.RUN_BY_ID(id));
	},

	// Scripting
	async getScriptCompletions(): Promise<ScriptCompletionsResponse> {
		return await httpClient.get<ScriptCompletionsResponse>(
			API_ENDPOINTS.SCRIPT_COMPLETIONS
		);
	},
};
