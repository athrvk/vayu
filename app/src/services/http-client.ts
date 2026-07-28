/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// HTTP Client - Fetch wrapper for UI-to-Engine communication

import { API_ENDPOINTS } from "@/config/api-endpoints";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/config/network";

/**
 * ApiError represents failures in UI-to-Engine communication.
 * This is NOT for HTTP errors from the target server (those come in the response body).
 *
 * Examples of ApiError scenarios:
 * - Engine is not running (connection refused)
 * - Engine returns HTTP 500 (internal engine error)
 * - Request to engine times out
 */
export class ApiError extends Error {
	constructor(
		public statusCode: number,
		public errorCode: string,
		message: string,
		public response?: any
	) {
		super(message);
		this.name = "ApiError";
	}
}

class HttpClient {
	private baseURL: string;

	constructor(baseURL: string) {
		this.baseURL = baseURL;
	}

	async request<T>(
		method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS",
		path: string,
		body?: unknown,
		options?: {
			timeout?: number;
			params?: Record<string, string>;
			headers?: Record<string, string>;
		}
	): Promise<T> {
		const controller = new AbortController();
		const timeout = options?.timeout || DEFAULT_REQUEST_TIMEOUT_MS;

		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			// Build URL with query params
			let url = `${this.baseURL}${path}`;
			if (options?.params) {
				const params = new URLSearchParams(options.params);
				url += `?${params.toString()}`;
			}

			// Build fetch options
			const fetchOptions: RequestInit = {
				method,
				signal: controller.signal,
				headers: {
					"ngrok-skip-browser-warning": "true",
					...options?.headers,
				},
			};

			// Add body and Content-Type for non-GET requests
			if (body) {
				fetchOptions.headers = {
					"Content-Type": "application/json",
					"ngrok-skip-browser-warning": "true",
					...options?.headers,
				};
				fetchOptions.body = JSON.stringify(body);
			}

			const response = await fetch(url, fetchOptions);

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				// The engine emits two error shapes and always has. Most routes
				// use `send_error` in routes.hpp, which writes a flat
				// `{"error": "some message"}`; a handful (POST /config, the
				// POST /runs config check, the auth pre-flight) write a nested
				// `{"error": {"code", "message"}}`. Reading only the nested one
				// meant every flat error - which is the large majority, and
				// includes every validation message the requests, collections
				// and environments routes produce - surfaced as a bare
				// "HTTP 400" with the reason silently dropped.
				//
				// Accept both here rather than converting 38 call sites across
				// nine route files: the fix belongs wherever the payload is
				// read, it makes every existing flat error legible at once, and
				// a route that later moves to the nested shape keeps working.
				const rawError: unknown = errorData?.error;
				const nested = typeof rawError === "object" && rawError !== null;
				const errorCode = nested
					? ((rawError as { code?: string }).code ?? "UNKNOWN_ERROR")
					: "UNKNOWN_ERROR";
				const errorMessage =
					(nested
						? (rawError as { message?: string }).message
						: typeof rawError === "string"
							? rawError
							: undefined) ?? `HTTP ${response.status}: ${response.statusText}`;

				throw new ApiError(response.status, errorCode, errorMessage, errorData);
			}

			return await response.json();
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			if (error instanceof Error) {
				if (error.name === "AbortError") {
					throw new Error("Request timeout");
				}
				throw new Error(`Network error: ${error.message}`);
			}
			throw new Error("Unknown error occurred");
		} finally {
			clearTimeout(timeoutId);
		}
	}

	async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		return this.request<T>("GET", path, undefined, { params });
	}

	async post<T>(path: string, body?: unknown, options?: { timeout?: number }): Promise<T> {
		return this.request<T>("POST", path, body, options);
	}

	async put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	async delete<T>(path: string, params?: Record<string, string>): Promise<T> {
		return this.request<T>("DELETE", path, undefined, { params });
	}

	async patch<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PATCH", path, body);
	}

	async options<T>(path: string): Promise<T> {
		return this.request<T>("OPTIONS", path);
	}
}

// Export singleton instance
export const httpClient = new HttpClient(API_ENDPOINTS.BASE_URL);
