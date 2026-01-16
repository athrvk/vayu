// HTTP Client - Fetch wrapper with error handling

import { API_ENDPOINTS } from "@/config/api-endpoints";
import { ErrorCode, ErrorMessages, ErrorStatusCodes } from "@/constants/error-codes";

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

	get isTimeout(): boolean {
		return this.errorCode === ErrorCode.TIMEOUT || this.statusCode === ErrorStatusCodes.TIMEOUT;
	}

	get isNetworkError(): boolean {
		return (
			[ErrorCode.CONNECTION_FAILED, ErrorCode.DNS_ERROR].includes(
				this.errorCode as typeof ErrorCode.CONNECTION_FAILED
			) ||
			[ErrorStatusCodes.BAD_GATEWAY, ErrorStatusCodes.CONNECTION_FAILED].includes(
				this.statusCode as typeof ErrorStatusCodes.BAD_GATEWAY
			)
		);
	}

	get isDatabaseError(): boolean {
		return this.errorCode === ErrorCode.DATABASE_ERROR;
	}

	get userFriendlyMessage(): string {
		// Try to get message from constants, fallback to original message
		return ErrorMessages[this.errorCode as keyof typeof ErrorMessages] || this.message;
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
		const timeout = options?.timeout || 30000;

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
				const errorCode = errorData.error?.code || "UNKNOWN_ERROR";
				const errorMessage =
					errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;

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

	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	async put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	async delete<T>(path: string): Promise<T> {
		return this.request<T>("DELETE", path);
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
