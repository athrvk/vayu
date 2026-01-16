/**
 * Request Transformer
 *
 * Transforms between frontend (snake_case) and backend (camelCase) request formats.
 */

import type { Request, CreateRequestRequest, UpdateRequestRequest } from "@/types";

/**
 * Backend request format (camelCase)
 */
export interface BackendRequest {
	id?: string;
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
	createdAt?: string | number;
	updatedAt?: string | number;
	// Also support snake_case for backward compatibility
	collection_id?: string;
	created_at?: string;
	updated_at?: string;
	body_type?: string;
	pre_request_script?: string;
	test_script?: string;
}

/**
 * Request Transformer
 *
 * Handles transformation between frontend (snake_case) and backend (camelCase) formats.
 */
export class RequestTransformer {
	/**
	 * Transform backend request (camelCase) to frontend request (snake_case)
	 */
	static toFrontend(backendRequest: BackendRequest): Request {
		if (!backendRequest.id) {
			throw new Error("Request must have an id");
		}

		return {
			id: backendRequest.id,
			collection_id: backendRequest.collectionId || backendRequest.collection_id || "",
			name: backendRequest.name,
			description: backendRequest.description,
			method: backendRequest.method as Request["method"],
			url: backendRequest.url,
			params: backendRequest.params || {},
			headers: backendRequest.headers,
			body: backendRequest.body,
			body_type: (backendRequest.bodyType || backendRequest.body_type) as
				| "json"
				| "text"
				| "form-data"
				| "x-www-form-urlencoded"
				| undefined,
			auth: backendRequest.auth,
			pre_request_script:
				backendRequest.preRequestScript || backendRequest.pre_request_script,
			test_script: backendRequest.postRequestScript || backendRequest.test_script,
			created_at: backendRequest.createdAt
				? typeof backendRequest.createdAt === "string"
					? backendRequest.createdAt
					: new Date(backendRequest.createdAt).toISOString()
				: backendRequest.created_at || new Date().toISOString(),
			updated_at: backendRequest.updatedAt
				? typeof backendRequest.updatedAt === "string"
					? backendRequest.updatedAt
					: new Date(backendRequest.updatedAt).toISOString()
				: backendRequest.updated_at || new Date().toISOString(),
		};
	}

	/**
	 * Transform frontend request (snake_case) to backend request (camelCase)
	 */
	static toBackend(data: CreateRequestRequest | UpdateRequestRequest): Partial<BackendRequest> {
		const backendData: Partial<BackendRequest> = {
			name: data.name,
			method: data.method,
			url: data.url,
		};

		// Handle ID for updates
		if ("id" in data && data.id) {
			backendData.id = data.id;
		}

		// Handle collection ID (only exists on CreateRequestRequest)
		if ("collection_id" in data && data.collection_id) {
			backendData.collectionId = data.collection_id;
		}

		// Handle description
		if ("description" in data && data.description !== undefined) {
			backendData.description = data.description;
		}

		// Optional fields - only include if they exist
		if (data.headers) backendData.headers = data.headers;
		if (data.params) backendData.params = data.params;
		if (data.body !== undefined) backendData.body = data.body;
		if (data.body_type) backendData.bodyType = data.body_type;
		if (data.auth) backendData.auth = data.auth;
		if (data.pre_request_script) {
			backendData.preRequestScript = data.pre_request_script;
		}
		if (data.test_script) {
			backendData.postRequestScript = data.test_script;
		}

		return backendData;
	}
}
