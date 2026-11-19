/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file http.ts
 * @brief Hosts the MCP server over Streamable HTTP on loopback, through the
 *        SDK's `createMcpHandler`: a fresh server per request, for both
 *        protocol eras. A 2026-07-28 client is served per request by design;
 *        a 2025-era one statelessly, which keeps the safety config current on
 *        every call. What a 2025-era client carries across requests is keyed
 *        by the `Mcp-Session-Id` issued here: its handshake name
 *        (`client-sessions.ts`), and an abort handle per request still in
 *        flight, so its cancel reaches it (`in-flight-calls.ts`). The Host and
 *        Origin checks the handler does not make are made here, so a browser
 *        tab cannot reach the endpoint through DNS rebinding (MCP spec
 *        requirement).
 */

import type http from "node:http";
import { randomUUID } from "node:crypto";
import {
	createMcpHandler,
	isInitializeRequest,
	isJSONRPCRequest,
	isLegacyRequest,
	isSpecType,
	type McpHandlerRequestOptions,
	type McpHttpHandler,
	type McpServer,
	type RequestId,
} from "@modelcontextprotocol/server";
import {
	localhostHostValidation,
	localhostOriginValidation,
	toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpServer, type McpServerInfo, type ToolContextProvider } from "./server.js";
import { MCP_PATH } from "../constants.js";
import type { Logger } from "../log.js";
import { answerInternalError, answerUnlessMcpPost, createMcpSocketServer } from "./gates.js";
import { ClientSessions } from "./client-sessions.js";
import { InFlightCalls, type InFlightCall } from "./in-flight-calls.js";
import { CALL_CANCELLED, HeldExchange, SERVER_STOPPED } from "./held-exchange.js";

export interface McpHttpServerOptions {
	host: string;
	port: number;
	info: McpServerInfo;
	contextProvider: ToolContextProvider;
	/** Where the cause of a 500 goes; the wire carries none of it. */
	log?: Logger;
	/** The 2025-era requests a cancel can reach; a test passes its own to read it. */
	inFlightCalls?: InFlightCalls;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Lifecycle wrapper around the Node HTTP server that fronts the MCP endpoint. */
export class McpHttpServer {
	private server: http.Server | null = null;
	private readonly opts: McpHttpServerOptions;
	private readonly sessions = new ClientSessions();
	private readonly inFlight: InFlightCalls;
	/** Every exchange still open, of either era, which a stop cuts. */
	private readonly exchanges = new Set<HeldExchange>();
	private handler: McpHttpHandler;
	private readonly hostIsLoopback = localhostHostValidation();
	private readonly originIsLoopback = localhostOriginValidation();

	constructor(opts: McpHttpServerOptions) {
		this.opts = opts;
		this.inFlight = opts.inFlightCalls ?? new InFlightCalls();
		this.handler = this.createHandler();
	}

	get url(): string {
		return `http://${this.opts.host}:${this.opts.port}${MCP_PATH}`;
	}

	isRunning(): boolean {
		return this.server !== null && this.server.listening;
	}

	start(): Promise<void> {
		if (this.server) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const server = createMcpSocketServer((req, res) => {
				void this.handleRequest(req, res);
			});
			server.on("error", reject);
			server.listen(this.opts.port, this.opts.host, () => {
				this.server = server;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		return this.endStreams().then(
			() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
		);
	}

	/**
	 * End every exchange a socket's close would otherwise wait on, on both
	 * legs. A 2026-07-28 exchange is ended by the SDK when its handler closes:
	 * a `subscriptions/listen` stream (which lasts as long as the client likes)
	 * with its own final answer, a call in flight with none. Every 2025-era
	 * exchange in flight is cut here, held in the cancel registry or not. The
	 * cut reaches the handler as a disconnect does, so the tool's signal fires
	 * and its engine request is aborted. What the client is sent depends on how
	 * far its answer got (#3598): a 2025-era call with nothing written yet has
	 * its connection dropped, so the client's fetch fails at once (a 2026-07-28
	 * one is answered with the SDK's bare `499`, as fast); a call of either era
	 * whose stream is under way (a progress event or a keep-alive comment is
	 * out) ends with a JSON-RPC error for its request id, the one thing that
	 * client acts on before its own timeout (`held-exchange.ts`).
	 * Everything else finishes as it would have: an upload still arriving is
	 * drained and answered (see `readJsonBody`), not cut off. The SDK's
	 * `close()` is final, so a fresh handler takes the next request.
	 */
	async endStreams(): Promise<void> {
		// Before `close()`: a stream the SDK ends must already carry its cause.
		for (const exchange of this.exchanges) {
			exchange.cut(SERVER_STOPPED);
			if (exchange.legacy && !exchange.answering) exchange.res.destroy();
		}
		this.exchanges.clear();
		const ending = this.handler;
		this.handler = this.createHandler();
		await ending.close();
	}

	private createHandler(): McpHttpHandler {
		return createMcpHandler(({ era, requestInfo }) => this.build(era, requestInfo), {
			// Nearly every report is a client's mistake (a wrong Accept or media
			// type, an unknown method), answered on the wire already. Vayu's own
			// fault is logged at `error` where it happens (`build`).
			onerror: (err) =>
				this.opts.log?.debug("mcp", "MCP request rejected", { error: err.message }),
		});
	}

	/**
	 * Tell every client that can hear it that `tools/list` has changed - a
	 * 2026-07-28 client holding a `subscriptions/listen` stream. A 2025-era
	 * client of this host has no stream to hear it on, and is not told it would.
	 */
	notifyToolsChanged(): void {
		this.handler.notify.toolsChanged();
	}

	/**
	 * Serve one request, answering a handler that threw past its own error
	 * paths with the 500 shape. Public so a socket bound elsewhere - the
	 * launch-time listener in `listener.ts` - can hand its requests here;
	 * `start()` puts the same handler on a socket of this server's own.
	 */
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		return this.handle(req, res).catch((err) =>
			answerInternalError(req, res, err, this.opts.log)
		);
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (answerUnlessMcpPost(req, res)) return;
		if (!this.hostIsLoopback(req, res) || !this.originIsLoopback(req, res)) return;

		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			// A client-side payload mistake is the client's, not a Vayu crash: the
			// generic catch above would answer 500 / -32603 ("Internal error"),
			// which reads as the server having fallen over. The body is read here
			// rather than by the handler so that an oversized upload is drained
			// rather than cut off (see `readJsonBody`), so the codes are answered
			// here too.
			//
			// Only the two *client-caused* failures are answered here, each with a
			// message written at its throw site. `readJsonBody` also rejects with
			// the socket's own error, which is neither the client's mistake nor
			// safe to echo - that keeps falling through to the 500 path, where a
			// dead socket belongs.
			if (!(err instanceof BodyReadError)) throw err;
			res.writeHead(err.status, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: err.rpcCode, message: err.message },
					id: null,
				})
			);
			return;
		}
		// An adapter per request: `serve` needs this exchange's response, which a stop destroys.
		const serveMcp = toNodeHandler({
			fetch: (request, options) => this.serve(request, options, res),
		});
		await serveMcp(req, res, body);
	}

	/**
	 * The web-standard face `toNodeHandler` calls: one request, both eras,
	 * answered on @p res.
	 */
	private async serve(
		request: Request,
		options: McpHandlerRequestOptions | undefined,
		res: http.ServerResponse
	): Promise<Response> {
		// The SDK's own routing predicate, so the host and the handler cannot
		// disagree about which leg serves the request.
		const legacy = await isLegacyRequest(request, options?.parsedBody);
		const exchange = new HeldExchange(res, options?.parsedBody, legacy);
		this.holdUntilClosed(exchange);
		const message = soleMessageOf(options?.parsedBody);
		const response = await this.fetchCancellable(request, options, message, exchange);
		const handshake = handshakeOf(message);
		if (!handshake || !response.ok) return response;
		// The stateless legacy leg sends no session id of its own and accepts any
		// it is sent, so the host issues one and records the handshake's name
		// under it. The body passes through untouched: the handler tears its
		// server down when that stream ends, so it must not be read or teed here.
		const issuedSessionId = randomUUID();
		this.sessions.remember(issuedSessionId, handshake.clientName);
		const headers = new Headers(response.headers);
		headers.set("Mcp-Session-Id", issuedSessionId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Count @p exchange among those a stop cuts until its response closes,
	 * however it closes. Every one, not only the calls `inFlight` holds: that
	 * registry is keyed and capped for cancels, and a call without a session
	 * id, inside a longer batch, evicted or replaced under its key still holds
	 * its connection open.
	 */
	private holdUntilClosed(exchange: HeldExchange): void {
		if (exchange.res.destroyed) return;
		this.exchanges.add(exchange);
		exchange.res.once("close", () => this.exchanges.delete(exchange));
	}

	/**
	 * Hand the request to the handler. A 2025-era request is served under a
	 * signal of the host's own, which a cut aborts: the SDK's legacy leg tears
	 * a request's server down when that signal aborts, which aborts the tool's
	 * `mcpReq.signal`. Under an issued session id, the request is also held in
	 * `inFlight` by its request id until its exchange ends, however it ends, so
	 * that client's `notifications/cancelled` cuts it (#3574).
	 */
	private async fetchCancellable(
		request: Request,
		options: McpHandlerRequestOptions | undefined,
		message: unknown,
		exchange: HeldExchange
	): Promise<Response> {
		// A 2026-07-28 exchange is the SDK's to cancel.
		if (!exchange.legacy) return exchange.relay(await this.handler.fetch(request, options));
		// Without a session id a cancel cannot be matched, since every client
		// counts its request ids from 0.
		const sessionId = request.headers.get("mcp-session-id") ?? undefined;
		const call = sessionId === undefined ? undefined : this.routeCancels(sessionId, message);
		call?.signal.addEventListener("abort", () => exchange.cut(CALL_CANCELLED), { once: true });
		// The client's disconnect still reaches the handler through this signal.
		const signal = AbortSignal.any([request.signal, exchange.signal]);
		try {
			const response = await this.handler.fetch(new Request(request, { signal }), options);
			return exchange.relay(response, () => call?.release());
		} catch (err) {
			call?.release();
			throw err;
		}
	}

	/**
	 * Apply the cancel @p message carries, if it is one, and register it for a
	 * later cancel if it is a request; the registration, or undefined.
	 */
	private routeCancels(sessionId: string, message: unknown): InFlightCall | undefined {
		const cancelled = cancelledRequestIdOf(message);
		// The cancel itself still goes on, for the 202 the client is owed.
		if (cancelled !== undefined) this.inFlight.cancel(sessionId, cancelled);
		return isJSONRPCRequest(message) ? this.inFlight.track(sessionId, message.id) : undefined;
	}

	/** The handler's factory: a server for one request of era @p era. */
	private build(era: "legacy" | "modern", request: Request | undefined): McpServer {
		try {
			return createMcpServer(this.opts.info, this.opts.contextProvider, {
				toolListChanges: era === "modern",
				sessionClientName: this.sessions.clientName(
					request?.headers.get("mcp-session-id") ?? undefined
				),
			});
		} catch (err) {
			// The handler answers this with a fixed 500 / -32603 and reports it to
			// `onerror` beside every client mistake; this one is Vayu's own fault,
			// so it is logged as one, cause included. The wire carries none of it.
			this.opts.log?.error("mcp", "Unhandled error serving an MCP request", {
				path: request ? new URL(request.url).pathname : MCP_PATH,
				error: err instanceof Error ? (err.stack ?? err.message) : String(err),
			});
			throw err;
		}
	}
}

/**
 * The one message a body carries, alone or as the one-message batch the SDK
 * also accepts; undefined for a longer batch.
 */
function soleMessageOf(body: unknown): unknown {
	if (!Array.isArray(body)) return body;
	return body.length === 1 ? body[0] : undefined;
}

/**
 * The client named by a message that is an `initialize`. Read from the body
 * rather than from a server: the one that answered is gone with its request,
 * and the stateless leg runs no server that sees the `initialized`
 * notification and the handshake both. `isInitializeRequest` is the SDK's own
 * schema check of the handshake, so a name it passes is one the SDK accepted.
 */
function handshakeOf(message: unknown): { clientName: string } | undefined {
	return isInitializeRequest(message)
		? { clientName: message.params.clientInfo.name }
		: undefined;
}

/** The request id a `notifications/cancelled` message names, by the SDK's own schema. */
function cancelledRequestIdOf(message: unknown): RequestId | undefined {
	return isSpecType.CancelledNotification(message) ? message.params.requestId : undefined;
}

/**
 * A body the *client* got wrong, carrying the status and JSON-RPC code that
 * says which way. Every message is a literal written here, never an underlying
 * error's text: the response goes to whoever can reach the endpoint, so it
 * states what the client did wrong and nothing about this process.
 *
 * Size and syntax are separate codes on purpose - the oversized body was never
 * parsed, so calling it malformed would send the client rewriting valid JSON.
 */
class BodyReadError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly rpcCode: number
	) {
		super(message);
	}
}

const bodyTooLarge = () =>
	new BodyReadError(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`, 413, -32600);

const bodyNotJson = () =>
	new BodyReadError("Parse error: the request body is not valid JSON.", 400, -32700);

/** Read and JSON-parse the request body, tolerating an empty body. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		req.on("data", (chunk: Buffer) => {
			// Past the cap the body keeps arriving and is thrown away chunk by
			// chunk. Neither of the alternatives delivers the 413 it is meant to:
			// destroying the socket, or closing it while the upload is still in
			// flight, resets the connection before the client can read the
			// response - it sees a dropped request, which is exactly what a
			// documented status code exists to prevent. (This showed up as a
			// macOS-only CI failure; on Linux the response happened to flush
			// first.) Draining costs bandwidth already committed by the sender
			// and protects what the cap is really for: this process's memory.
			if (overflowed) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				overflowed = true;
				chunks = [];
				reject(bodyTooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			// Already rejected with the 413; the drain finishing is not a result.
			if (overflowed) return;
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.trim() === "") {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(bodyNotJson());
			}
		});
		req.on("error", reject);
	});
}
