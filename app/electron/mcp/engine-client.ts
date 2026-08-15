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

/**
 * Raised when *this client's* abort budget expired before the engine answered -
 * distinct from the caller cancelling and from an unreachable engine. The
 * engine is still working on the call when this throws, so a caller must not
 * report it as "engine not running" or advise a blind retry: the request may
 * already have been sent and recorded. Carries the budget so the message can
 * name it.
 */
export class EngineTimeoutError extends Error {
	constructor(
		method: string,
		path: string,
		readonly timeoutMs: number
	) {
		super(`No response from the engine within ${timeoutMs}ms for ${method} ${path}`);
		this.name = "EngineTimeoutError";
	}
}

export interface EngineClientOptions {
	/** Base URL of the engine, e.g. `http://127.0.0.1:9876`. */
	baseUrl: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Injectable fetch (defaults to global fetch) - used to mock in tests. */
	fetchImpl?: typeof fetch;
}

/**
 * Budget for engine-local calls - reads, writes, composition, run bookkeeping.
 * These never wait on a third-party server, so a stall here is a stuck engine.
 */
const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * The three values below mirror `app/src/config/network.ts` (the renderer
 * derives the same budget for its proxied calls); the main process cannot
 * import renderer modules, so they are duplicated here. Keep them in sync.
 *
 * Grace on top of the engine's own timeout, so the engine's TIMEOUT error -
 * which carries a proper error code and a recorded run - always arrives before
 * this client gives up.
 */
const PROXIED_TIMEOUT_GRACE_MS = 10_000;

/**
 * Ceiling of the engine's `defaultTimeout` setting (`seed_default_config` in
 * engine/src/db/database.cpp caps it at 300000). Used when the setting cannot
 * be read, so an unreadable config never shortens the budget below what the
 * engine may legitimately take.
 */
const ENGINE_MAX_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Budget for the `GET /config` probe that derives the one above. Deliberately
 * short: it reads a local SQLite-backed row, and a slow answer must not delay
 * the call it is sizing - a failed probe falls back to the ceiling.
 */
const CONFIG_PROBE_TIMEOUT_MS = 2_000;

/** A single decoded live-metrics tick (shape mirrors the engine SSE payload). */
export type MetricsTick = Record<string, unknown>;

/**
 * What one budgeted read of a streaming run's events produced (issue #575).
 *
 * `completed` and `capReached` are the two ways a read can stop short, and they
 * are kept apart because they mean different things to an agent: one says the
 * stream is over, the other says this read is. Neither is inferable from
 * `events.length`, which is why both are carried rather than derived.
 */
export interface StreamConsumeResult {
	events: Array<Record<string, unknown>>;
	/** The relay's `event: complete` arrived - the stream itself has ended. */
	completed: boolean;
	/** The read stopped at `maxEvents`, not at the end of the stream. */
	capReached: boolean;
	/** Why the stream ended, from the completion frame. Absent if it has not. */
	endReason?: string;
	/** Every event the run received, which exceeds `events.length` when this
	 *  read was capped or budgeted out. */
	totalEvents?: number;
}

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

	private async request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = this.timeoutMs
	): Promise<T> {
		const controller = new AbortController();
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			controller.abort();
		}, timeoutMs);
		// Abort on either our timeout or the caller's signal (MCP tool cancellation).
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		try {
			const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: combined,
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
		} catch (err) {
			// Only *our* timer expiring is a timeout; the caller's cancellation
			// aborts the same fetch and must stay distinguishable from it.
			if (expired && isAbortError(err)) throw new EngineTimeoutError(method, path, timeoutMs);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Abort budget for a call that proxies a third-party server. Such a call is
	 * bounded engine-side by the payload's own `timeout` or, absent one, the
	 * user-configurable `defaultTimeout` setting (`resolve_request_timeout_ms`,
	 * engine/src/http/routes/execution.cpp) - which reaches 300s, far past the
	 * engine-local default. Sizing the client budget off that setting is what
	 * keeps a legitimately slow request from being aborted here while the engine
	 * completes it there, with the side effects and the run row already real.
	 *
	 * MCP-composed payloads carry no `timeout` of their own (`payload_from_stored`
	 * emits none), so the config read - not the payload - is what does the work;
	 * the `max` covers an inline payload that does carry a larger one.
	 */
	private async proxiedTimeoutMs(payload: unknown, signal?: AbortSignal): Promise<number> {
		let configured = 0;
		try {
			const cfg = await this.request<unknown>(
				"GET",
				"/config",
				undefined,
				signal,
				CONFIG_PROBE_TIMEOUT_MS
			);
			configured = readDefaultTimeoutMs(cfg);
		} catch {
			// Unreachable, slow or malformed config: fall back to the ceiling
			// rather than to a budget shorter than the engine may take.
		}
		const base = Math.max(
			readPayloadTimeoutMs(payload),
			configured > 0 ? configured : ENGINE_MAX_DEFAULT_TIMEOUT_MS
		);
		return base + PROXIED_TIMEOUT_GRACE_MS;
	}

	// --- Health & metadata ---------------------------------------------------

	health(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/health", undefined, signal);
	}

	// --- Read: collections / requests / environments / runs ------------------

	listCollections(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/collections", undefined, signal);
	}

	listRequests(collectionId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`/requests?collectionId=${encodeURIComponent(collectionId)}`,
			undefined,
			signal
		);
	}

	listEnvironments(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/environments", undefined, signal);
	}

	/**
	 * Fetch a single environment by id. The engine exposes no `GET
	 * /environments/:id` route (only the list + `POST`/`DELETE`), so we resolve it
	 * from the list - which already returns each environment in full, including its
	 * `variables`. Returns `null` when no environment matches.
	 */
	async getEnvironment(id: string, signal?: AbortSignal): Promise<unknown> {
		const list = await this.request<unknown>("GET", "/environments", undefined, signal);
		const arr = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
		return arr.find((e) => e && typeof e === "object" && e.id === id) ?? null;
	}

	/**
	 * Fetch a single saved request by id (`GET /requests/:id`). Used to name what
	 * a delete is about to destroy before the user is asked to confirm it - a
	 * confirmation prompt carrying only an opaque id is not one a human can
	 * answer. A 404 arrives as an {@link EngineRequestError}, which is what the
	 * caller turns into "no such saved request" rather than deleting blind.
	 */
	getRequest(id: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", `/requests/${encodeURIComponent(id)}`, undefined, signal);
	}

	/**
	 * First page of run history (newest first), bounded so an agent never pulls
	 * unbounded history. Returns the `{data, pagination}` envelope; `data` rows
	 * carry the compact `summary`, not the full config_snapshot.
	 */
	listRuns(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/runs?limit=100&offset=0", undefined, signal);
	}

	/**
	 * One run's row (`GET /runs/:id`), including which saved request it ran and
	 * whether it is pinned as a baseline. `compare_runs` reads the first to find
	 * a target's baseline when the caller named none.
	 */
	getRun(runId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", `/runs/${encodeURIComponent(runId)}`, undefined, signal);
	}

	/**
	 * The runs pinned as baselines for one saved request, newest first. One row
	 * is all any caller needs - "the baseline" is the most recent pin - so the
	 * page is bounded to it rather than to the 100 `listRuns` allows.
	 */
	listBaselineRuns(requestId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`/runs?baseline=true&limit=1&offset=0&requestId=${encodeURIComponent(requestId)}`,
			undefined,
			signal
		);
	}

	getRunReport(runId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", `/runs/${encodeURIComponent(runId)}/report`, undefined, signal);
	}

	// --- Engine configuration ------------------------------------------------

	getConfig(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/config", undefined, signal);
	}

	// --- Script sandbox surface ----------------------------------------------

	/**
	 * The script sandbox's API surface: every `pm.*` name, global and assertion
	 * chain the QuickJS runtime installs. Generated engine-side from one table
	 * and cross-checked against the runtime by `script_completions_test.cpp`,
	 * which is why both the editor and MCP read it rather than describing the
	 * sandbox themselves (issue #233).
	 */
	getScriptCompletions(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/scripting/completions", undefined, signal);
	}

	updateConfig(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/config", payload, signal);
	}

	// --- Write: saved requests / environments --------------------------------
	//
	// POST creates, PUT updates - the engine split the verbs in #95, so these
	// are no longer interchangeable: a POST carrying a known id is a 409, and a
	// PUT to an unknown id is a 404.

	/** Create a collection: `POST /collections` (the engine assigns the id). */
	createCollection(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/collections", payload, signal);
	}

	/**
	 * Update a collection: `PUT /collections/:id`. The engine merge-patches -
	 * absent fields keep their stored value - so the body carries only what the
	 * caller stated.
	 */
	updateCollection(id: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("PUT", `/collections/${encodeURIComponent(id)}`, payload, signal);
	}

	/**
	 * Delete a collection: `DELETE /collections/:id`. **Cascades** - every
	 * descendant collection and every request inside them go with it, which is
	 * why the tool that calls this reads the subtree first and asks the user.
	 */
	deleteCollection(id: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("DELETE", `/collections/${encodeURIComponent(id)}`, undefined, signal);
	}

	/** Create a saved request: `POST /requests` (the engine assigns the id). */
	createRequest(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/requests", payload, signal);
	}

	/**
	 * Update a saved request: `PUT /requests/:id`. Merge-patch engine-side, the
	 * same as {@link updateCollection} - a body naming only `name` leaves the
	 * stored url, headers and scripts alone.
	 */
	updateRequest(id: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("PUT", `/requests/${encodeURIComponent(id)}`, payload, signal);
	}

	/** Delete a saved request: `DELETE /requests/:id`. */
	deleteRequest(id: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("DELETE", `/requests/${encodeURIComponent(id)}`, undefined, signal);
	}

	/** Update an environment: `PUT /environments/:id` (merge-patch body). */
	updateEnvironment(id: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("PUT", `/environments/${encodeURIComponent(id)}`, payload, signal);
	}

	// --- Execute -------------------------------------------------------------

	/**
	 * Compose a request engine-side: `POST /compose` resolves `{{variables}}`
	 * and `inherit` auth (walking the collection chain) and returns the
	 * execute-ready payload that {@link executeRequest} / {@link startRun}
	 * accept unchanged. Pure - it sends nothing and creates no run row, which
	 * is what lets the allowlist gate read the *resolved* URL before any
	 * traffic flows. This replaced the MCP-side composition copy (issue #226).
	 */
	composeRequest(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/compose", payload, signal);
	}

	/**
	 * Send a composed request. This is the one call that waits on a third-party
	 * server, so it gets the derived budget (see {@link proxiedTimeoutMs}) rather
	 * than the engine-local default. `/compose` and `POST /runs` stay on the
	 * default: both return as soon as the engine has done local work.
	 */
	async executeRequest(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		const timeoutMs = await this.proxiedTimeoutMs(payload, signal);
		return this.request("POST", "/execute", payload, signal, timeoutMs);
	}

	startRun(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/runs", payload, signal);
	}

	stopRun(runId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", `/runs/${encodeURIComponent(runId)}/stop`, undefined, signal);
	}

	/**
	 * Read a bounded snapshot of live metrics without holding a stream open.
	 * Connects to the SSE endpoint (which replays the retained tick buffer from
	 * offset 0), collects `metrics` ticks until the run completes or `budgetMs`
	 * elapses, and returns the last `limit` ticks. This keeps `tools/call`
	 * request/response - MCP tools do not stream.
	 */
	async getLiveMetricsSnapshot(
		runId: string,
		limit = 10,
		budgetMs = 1500,
		signal?: AbortSignal
	): Promise<MetricsTick[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), budgetMs);
		// Stop on our time budget or the caller's cancellation, whichever first.
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const ticks: MetricsTick[] = [];
		try {
			const res = await this.fetchImpl(
				`${this.baseUrl}/runs/${encodeURIComponent(runId)}/live`,
				{
					method: "GET",
					headers: { Accept: "text/event-stream" },
					signal: combined,
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new EngineRequestError(
					`Engine responded ${res.status} for GET /runs/${runId}/live`,
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
			// A timeout abort is expected for still-running runs - return what we
			// collected. Re-throw genuine engine errors.
			if (err instanceof EngineRequestError) throw err;
			if (!(err instanceof Error) || err.name !== "AbortError") throw err;
		} finally {
			clearTimeout(timer);
		}
		return ticks.slice(-limit);
	}

	/**
	 * Consume a streaming request's events into a list, under a hard budget
	 * (issue #575).
	 *
	 * The same shape as {@link getLiveMetricsSnapshot} and for the same reason:
	 * `tools/call` is request/response, so an agent cannot be handed a stream -
	 * it is handed what the stream produced within a stated bound. Both bounds
	 * are real and both are disclosed by the caller: `maxEvents` caps the list
	 * and `budgetMs` caps the wait, so a stream that never ends still answers.
	 *
	 * `?lastEventId=` is deliberately not used. This connects once, from offset
	 * zero, and takes what the ring replays plus what arrives while it waits;
	 * resuming belongs to a live consumer that means to stay, which this is the
	 * opposite of.
	 *
	 * @returns the events it collected and how the read ended. `completed` is
	 *   the relay's own `event: complete`, so a partial read is never reported
	 *   as a finished stream - the distinction the disclosure rests on.
	 */
	async consumeStreamEvents(
		runId: string,
		maxEvents = 50,
		budgetMs = 5_000,
		signal?: AbortSignal
	): Promise<StreamConsumeResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), budgetMs);
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const out: StreamConsumeResult = { events: [], completed: false, capReached: false };
		try {
			const res = await this.fetchImpl(
				`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`,
				{
					method: "GET",
					headers: { Accept: "text/event-stream" },
					signal: combined,
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new EngineRequestError(
					`Engine responded ${res.status} for GET /runs/${runId}/events`,
					res.status,
					text
				);
			}
			if (!res.body) return out;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let done = false;
			while (!done) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					const parsed = parseSseEvent(frame);
					if (!parsed) continue;
					if (parsed.event === "complete") {
						out.completed = true;
						if (parsed.data) {
							try {
								const payload = JSON.parse(parsed.data) as Record<string, unknown>;
								if (typeof payload.reason === "string")
									out.endReason = payload.reason;
								if (typeof payload.totalEvents === "number")
									out.totalEvents = payload.totalEvents;
							} catch {
								// A completion frame we cannot read still ends the
								// stream; what it said is simply not reported.
							}
						}
						done = true;
						break;
					}
					// `open` carries the initial status line, not an event - it is
					// the response, which the caller already has from the 202 path.
					if (parsed.event !== "message" || !parsed.data) continue;
					if (out.events.length >= maxEvents) {
						// Stop reading rather than collecting and slicing: the point
						// of the cap is to bound the work, and a stream that is
						// still talking would otherwise be read to its budget.
						out.capReached = true;
						done = true;
						break;
					}
					try {
						out.events.push(JSON.parse(parsed.data) as Record<string, unknown>);
					} catch {
						// Ignore malformed frames, as the metrics reader does.
					}
				}
			}
			await reader.cancel().catch(() => {});
		} catch (err) {
			// A budget abort is the expected end of a stream that outlasts it -
			// return what was collected. Genuine engine errors still throw.
			if (err instanceof EngineRequestError) throw err;
			if (!(err instanceof Error) || err.name !== "AbortError") throw err;
		} finally {
			clearTimeout(timer);
		}
		return out;
	}

	// --- Local services: the OAuth 2.0 mock issuer ---------------------------
	//
	// Every issuer binds `127.0.0.1` and the engine takes no host for it
	// (`mock_issuer.cpp`: "127.0.0.1 only, never configurable"), so none of these
	// three reaches anything off the machine - which is why the tools over them
	// carry no allowlist check.

	/**
	 * Start a mock issuer: `POST /mock-issuer/start`. The engine assigns the id
	 * and, for `port: 0`, the port; the reply carries `issuerId`, `issuerUrl`,
	 * `tokenUrl`, `authorizeUrl` and the per-issuer `signingKey`.
	 */
	startMockIssuer(payload: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.request("POST", "/mock-issuer/start", payload, signal);
	}

	/** The running mock issuers: `GET /mock-issuer` → `{issuers: [...]}`. */
	listMockIssuers(signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", "/mock-issuer", undefined, signal);
	}

	/**
	 * Stop one: `POST /mock-issuer/:id/stop`. An unknown id is a 404, which
	 * arrives as an {@link EngineRequestError} rather than a silent success -
	 * "the issuer you meant is gone" and "it stopped" are different answers.
	 */
	stopMockIssuer(issuerId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"POST",
			`/mock-issuer/${encodeURIComponent(issuerId)}/stop`,
			undefined,
			signal
		);
	}
}

/** True for the rejection a fetch produces when its signal aborts. */
function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Read the engine's `defaultTimeout` (milliseconds) out of a `GET /config`
 * body. Values arrive as strings. Returns 0 when the entry is absent or not a
 * positive number, which the caller reads as "unknown".
 */
function readDefaultTimeoutMs(config: unknown): number {
	const raw =
		config && typeof config === "object" ? (config as Record<string, unknown>).entries : null;
	const entries = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	const entry = entries.find((e) => e && typeof e === "object" && e.key === "defaultTimeout");
	const value = Number(entry?.value);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A payload's own `timeout` override in milliseconds, or 0 when it carries none. */
function readPayloadTimeoutMs(payload: unknown): number {
	const value =
		payload && typeof payload === "object"
			? (payload as Record<string, unknown>).timeout
			: undefined;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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
