/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// HTTP Client - Fetch wrapper for UI-to-Engine communication

import { API_ENDPOINTS } from "@/config/api-endpoints";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/config/network";
import { SSE_ACCEPT } from "@/constants/request";

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
		public response?: unknown
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * One message from a streamed engine call (issue #882).
 *
 * `event` is an SSE frame, in the order the engine wrote it. `buffered` is the
 * whole response body arriving at once, which happens when the engine has never
 * heard of streaming for this route - the app and the sidecar are not updated
 * together, so a new app can be talking to an older engine. Discriminated rather
 * than folded into an event with a reserved name: a consumer has to be able to
 * tell "the engine reported nothing along the way" from "the engine reported
 * this", and a name it had to know was special would not say that.
 */
export type StreamMessage =
	| { kind: "event"; event: string; data: unknown }
	| { kind: "buffered"; data: unknown };

/**
 * The failure an engine response carries, as an `ApiError`.
 *
 * Shared by `request` and `stream`: a streamed call is refused before its stream
 * opens with exactly the body a buffered one is refused with, so reading that
 * body in two places would be two chances to read it differently - which is the
 * defect issue #173 was.
 */
async function readApiError(response: Response): Promise<ApiError> {
	const errorData = (await response.json().catch(() => ({}))) as { error?: unknown };
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

	return new ApiError(response.status, errorCode, errorMessage, errorData);
}

/**
 * The error a caller's own cancel raises (issue #893).
 *
 * Named `AbortError` because that is what the platform calls this and what a
 * caller already checks for; a bespoke class would be a second vocabulary for
 * the one thing `fetch` and every other cancellable API already agree on.
 */
function abortError(): Error {
	const error = new Error("Aborted by the caller");
	error.name = "AbortError";
	return error;
}

/**
 * Split a buffer into whole SSE frames, keeping whatever is still incomplete.
 *
 * A `ReadableStream` hands over whatever arrived, not whole frames, so a frame
 * straddling a chunk boundary is the normal case rather than the edge one - and
 * with megabytes of content in a single `result` frame it is a certainty. `\r\n`
 * is normalized because SSE permits it; the engine writes `\n`.
 */
function takeFrames(buffer: string): { frames: string[]; rest: string } {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const parts = normalized.split("\n\n");
	return { frames: parts.slice(0, -1), rest: parts[parts.length - 1] };
}

/**
 * One SSE frame's event name and data, or null for a frame that carries neither.
 *
 * A line beginning `:` is SSE's comment - the keep-alive the engine's relays
 * write - and a frame with no `event:` line is named `message`, which is the
 * spec's default rather than a reason to drop it.
 */
function parseFrame(frame: string): { event: string; data: unknown } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "data") dataLines.push(value);
		// `id` and `retry` are the stream's own bookkeeping; nothing here resumes.
	}
	if (dataLines.length === 0) return null;
	return { event, data: JSON.parse(dataLines.join("\n")) };
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
				throw await readApiError(response);
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

	/**
	 * POST that consumes a `text/event-stream` response as it arrives
	 * (issue #882).
	 *
	 * The timeout is an **idle** one, not a total: the whole point of a streamed
	 * call is work that takes longer than a request should, and a 10 MB download
	 * arriving steadily over a minute is healthy while thirty seconds of silence
	 * is not. Every chunk resets it, so what is bounded is the stall rather than
	 * the transfer - which is also what lets this outlive `proxiedRequestTimeoutMs`.
	 *
	 * A response that is not a stream yields one `buffered` message instead of
	 * being retried: the engine has already done the work, and asking again would
	 * be asking for the same megabytes twice.
	 *
	 * @param options.signal the caller's own cancel (issue #893). Abandoning the
	 * iteration already releases the stream, but a caller that is *not* iterating -
	 * a dialog closing while an awaited helper sits in the loop on its behalf - has
	 * no way to reach that, and the engine goes on downloading megabytes for
	 * nobody. An abort through this raises an `AbortError`, kept distinct from the
	 * idle stall's `Request timeout`: both end in an `AbortController`, and a
	 * deliberate cancel reported as a timeout is a banner about a failure nobody
	 * had.
	 */
	async *stream(
		path: string,
		body?: unknown,
		options?: {
			idleTimeout?: number;
			headers?: Record<string, string>;
			signal?: AbortSignal;
		}
	): AsyncGenerator<StreamMessage> {
		const controller = new AbortController();
		const caller = options?.signal;
		// Checked before the request is built, not only linked: a signal that was
		// already aborted must not put a request on the wire that the next line
		// would cancel - the engine would start a download and be hung up on.
		if (caller?.aborted) {
			throw abortError();
		}
		const onCallerAbort = () => controller.abort();
		caller?.addEventListener("abort", onCallerAbort);
		const idleTimeout = options?.idleTimeout || DEFAULT_REQUEST_TIMEOUT_MS;
		let idleTimer = setTimeout(() => controller.abort(), idleTimeout);
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => controller.abort(), idleTimeout);
		};
		// Held outside the try so the `finally` can let go of it. A consumer that
		// stops reading - the import dialog closing mid-download - resumes this
		// generator at its `finally` and nowhere else, so this is the only place
		// the stream can be released from. Left open, the engine keeps reading a
		// download for a listener that has gone.
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		try {
			const response = await fetch(`${this.baseURL}${path}`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					Accept: SSE_ACCEPT,
					"ngrok-skip-browser-warning": "true",
					...options?.headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});

			if (!response.ok) {
				throw await readApiError(response);
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes(SSE_ACCEPT) || !response.body) {
				yield { kind: "buffered", data: await response.json() };
				return;
			}

			reader = response.body.getReader();
			const decoder = new TextDecoder("utf-8");
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				resetIdle();
				buffer += decoder.decode(value, { stream: true });
				const { frames, rest } = takeFrames(buffer);
				buffer = rest;
				for (const frame of frames) {
					const parsed = parseFrame(frame);
					if (parsed) yield { kind: "event", ...parsed };
				}
			}
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			// Which abort this was is not knowable from the error - `fetch` raises
			// the same `AbortError` for both - only from which signal is set.
			if (caller?.aborted) {
				throw abortError();
			}
			if (error instanceof Error) {
				if (error.name === "AbortError") {
					throw new Error("Request timeout");
				}
				throw new Error(`Network error: ${error.message}`);
			}
			throw new Error("Unknown error occurred");
		} finally {
			caller?.removeEventListener("abort", onCallerAbort);
			clearTimeout(idleTimer);
			// Cancelling releases the socket, which is what makes the engine's SSE
			// write fail and its transfer stop. Ignored on failure: the stream may
			// already be errored, and there is nothing left to do about it.
			void reader?.cancel().catch(() => {});
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
