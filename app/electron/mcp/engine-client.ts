/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file engine-client.ts
 * @brief Thin main-process HTTP client for the Vayu engine REST API
 *        (http://127.0.0.1:9876). The Electron main process cannot import the
 *        renderer's `@/services` client, so this is a minimal standalone
 *        wrapper over `fetch`. Responses are passed through to MCP tools as
 *        JSON, so return types are intentionally loose.
 */

/** Raised for non-2xx engine responses, carrying the status and body text. */
export class EngineRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string
	) {
		super(message);
		this.name = "EngineRequestError";
	}
}

export interface EngineClientOptions {
	/** Base URL of the engine, e.g. `http://127.0.0.1:9876`. */
	baseUrl: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Injectable fetch (defaults to global fetch) — used to mock in tests. */
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 35_000;

/** A single decoded live-metrics tick (shape mirrors the engine SSE payload). */
export type MetricsTick = Record<string, unknown>;

/**
 * Minimal engine client. One method per endpoint the MCP tools need. Every
 * method returns parsed JSON (or throws {@link EngineRequestError}).
 */
export class EngineClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: EngineClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			const text = await res.text();
			if (!res.ok) {
				throw new EngineRequestError(
					`Engine responded ${res.status} for ${method} ${path}`,
					res.status,
					text
				);
			}
			return (text ? JSON.parse(text) : null) as T;
		} finally {
			clearTimeout(timer);
		}
	}

	// --- Health & metadata ---------------------------------------------------

	health(): Promise<unknown> {
		return this.request("GET", "/health");
	}

	// --- Read: collections / requests / environments / runs ------------------

	listCollections(): Promise<unknown> {
		return this.request("GET", "/collections");
	}

	listRequests(collectionId: string): Promise<unknown> {
		return this.request("GET", `/requests?collectionId=${encodeURIComponent(collectionId)}`);
	}

	listEnvironments(): Promise<unknown> {
		return this.request("GET", "/environments");
	}

	listRuns(): Promise<unknown> {
		return this.request("GET", "/runs");
	}

	getRunReport(runId: string): Promise<unknown> {
		return this.request("GET", `/run/${encodeURIComponent(runId)}/report`);
	}

	// --- Execute -------------------------------------------------------------

	executeRequest(payload: unknown): Promise<unknown> {
		return this.request("POST", "/request", payload);
	}

	startRun(payload: unknown): Promise<unknown> {
		return this.request("POST", "/run", payload);
	}

	stopRun(runId: string): Promise<unknown> {
		return this.request("POST", `/run/${encodeURIComponent(runId)}/stop`);
	}

	/**
	 * Read a bounded snapshot of live metrics without holding a stream open.
	 * Connects to the SSE endpoint (which replays the retained tick buffer from
	 * offset 0), collects `metrics` ticks until the run completes or `budgetMs`
	 * elapses, and returns the last `limit` ticks. This keeps `tools/call`
	 * request/response — MCP tools do not stream.
	 */
	async getLiveMetricsSnapshot(
		runId: string,
		limit = 10,
		budgetMs = 1500
	): Promise<MetricsTick[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), budgetMs);
		const ticks: MetricsTick[] = [];
		try {
			const res = await this.fetchImpl(
				`${this.baseUrl}/metrics/live/${encodeURIComponent(runId)}`,
				{
					method: "GET",
					headers: { Accept: "text/event-stream" },
					signal: controller.signal,
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new EngineRequestError(
					`Engine responded ${res.status} for GET /metrics/live/${runId}`,
					res.status,
					text
				);
			}
			if (!res.body) return ticks;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let done = false;
			while (!done) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const events = buffer.split("\n\n");
				buffer = events.pop() ?? "";
				for (const evt of events) {
					const parsed = parseSseEvent(evt);
					if (!parsed) continue;
					if (parsed.event === "complete") {
						done = true;
						break;
					}
					if (parsed.event === "metrics" && parsed.data) {
						try {
							ticks.push(JSON.parse(parsed.data) as MetricsTick);
						} catch {
							// Ignore malformed tick lines.
						}
					}
				}
			}
			await reader.cancel().catch(() => {});
		} catch (err) {
			// A timeout abort is expected for still-running runs — return what we
			// collected. Re-throw genuine engine errors.
			if (err instanceof EngineRequestError) throw err;
			if (!(err instanceof Error) || err.name !== "AbortError") throw err;
		} finally {
			clearTimeout(timer);
		}
		return ticks.slice(-limit);
	}
}

/** Parse one SSE event block ("event: x\ndata: y") into its fields. */
function parseSseEvent(block: string): { event?: string; data?: string } | null {
	const lines = block.split("\n");
	let event: string | undefined;
	const dataParts: string[] = [];
	for (const line of lines) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
	}
	if (event === undefined && dataParts.length === 0) return null;
	return { event, data: dataParts.length ? dataParts.join("\n") : undefined };
}
