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
	/** The response of every 2025-era exchange still open, which a stop drops. */
	private readonly legacyExchanges = new Set<http.ServerResponse>();
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
	 * End every exchange a socket's close would otherwise wait on: what a
	 * 2026-07-28 client holds open (a `subscriptions/listen` stream lasts as long
	 * as the client likes), which the SDK ends; and every 2025-era exchange in
	 * flight, whose connection is dropped with no result and no error written
	 * (#3575). The drop reaches the handler as a disconnect does, so the tool's
	 * signal fires and its engine request is aborted. A client still waiting for
	 * the response headers sees its fetch fail at once; one already reading the
	 * stream (a keep-alive comment or a progress event was sent) holds the call
	 * until its own timeout. Everything else finishes as it would have: an
	 * upload still arriving is drained and answered (see `readJsonBody`), not
	 * cut off. The SDK's `close()` is final, so a fresh handler takes the next
	 * request.
	 */
	async endStreams(): Promise<void> {
		for (const res of this.legacyExchanges) res.destroy();
		this.legacyExchanges.clear();
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
		if (await isLegacyRequest(request, options?.parsedBody)) this.holdUntilClosed(res);
		const message = soleMessageOf(options?.parsedBody);
		const response = await this.fetchCancellable(request, options, message);
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
	 * Count @p res among the 2025-era exchanges a stop drops until it closes,
	 * however it closes. Every one, not only the calls `inFlight` holds: that
	 * registry is keyed and capped for cancels, and a call without a session
	 * id, inside a longer batch, evicted or replaced under its key still holds
	 * its connection open.
	 */
	private holdUntilClosed(res: http.ServerResponse): void {
		if (res.destroyed) return;
		this.legacyExchanges.add(res);
		res.once("close", () => this.legacyExchanges.delete(res));
	}

	/**
	 * Hand the request to the handler, wiring a 2025-era client's
	 * `notifications/cancelled` to the request it names: each request is served
	 * under a signal of the host's own, held in `inFlight` under the session id
	 * and request id until its exchange ends, however it ends. The SDK's legacy
	 * leg tears a request's server down when that signal aborts, which aborts
	 * the tool's `mcpReq.signal` (#3574).
	 */
	private async fetchCancellable(
		request: Request,
		options: McpHandlerRequestOptions | undefined,
		message: unknown
	): Promise<Response> {
		// Absent on every 2026-07-28 exchange, which the SDK cancels itself; and
		// without one a cancel cannot be matched, since every client counts its
		// request ids from 0.
		const sessionId = request.headers.get("mcp-session-id") ?? undefined;
		if (sessionId === undefined) return this.handler.fetch(request, options);
		const cancelled = cancelledRequestIdOf(message);
		// The cancel itself still goes on, for the 202 the client is owed.
		if (cancelled !== undefined) this.inFlight.cancel(sessionId, cancelled);
		if (!isJSONRPCRequest(message)) return this.handler.fetch(request, options);

		const call = this.inFlight.track(sessionId, message.id);
		// The client's disconnect still reaches the handler through this signal.
		const signal = AbortSignal.any([request.signal, call.signal]);
		try {
			const response = await this.handler.fetch(new Request(request, { signal }), options);
			return releasedAtEnd(response, call);
		} catch (err) {
			call.release();
			throw err;
		}
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
 * @p response with its body passed through on demand, releasing @p call when
 * the body ends, fails or is cancelled. Nothing is read ahead of the reader:
 * the handler tears its server down when its own stream ends.
 */
function releasedAtEnd(response: Response, call: InFlightCall): Response {
	if (response.body === null) {
		call.release();
		return response;
	}
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (!done) return controller.enqueue(value);
					call.release();
					controller.close();
				} catch (err) {
					call.release();
					controller.error(err);
				}
			},
			cancel(reason) {
				call.release();
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 }
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
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
