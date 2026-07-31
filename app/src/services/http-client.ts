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
				// The engine emits one shape since issue #173:
				// `{"error": {"code", "message"}}`, built by `error_body` in
				// routes.hpp. It used to emit two - most routes wrote a flat
				// `{"error": "some message"}` and a handful wrote the nested
				// object - and reading only the nested one dropped every
				// validation message the requests, collections and environments
				// routes produce, surfacing them as a bare "HTTP 400".
				//
				// The flat branch stays as a fallback, not as an alternative
				// contract: the app and the engine sidecar are not updated
				// atomically, so a new app can be talking to an older engine,
				// and reading its message is better than showing the status
				// line. Anything else - a body that is not JSON, an `error`
				// that is neither - still falls back to the status text.
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
