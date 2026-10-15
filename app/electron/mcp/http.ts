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
 *        every call. The one thing carried across requests is a 2025-era
 *        client's handshake name, keyed by an `Mcp-Session-Id`
 *        (`client-sessions.ts`). The Host and Origin checks the handler does
 *        not make are made here, so a browser tab cannot reach the endpoint
 *        through DNS rebinding (MCP spec requirement).
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import {
	createMcpHandler,
	isInitializeRequest,
	type McpHandlerRequestOptions,
	type McpHttpHandler,
	type McpServer,
} from "@modelcontextprotocol/server";
import {
	localhostHostValidation,
	localhostOriginValidation,
	toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpServer, type McpServerInfo, type ToolContextProvider } from "./server.js";
import { MCP_PATH } from "../constants.js";
import type { Logger } from "../log.js";
import { answerInternalError, answerUnlessMcpPost, closeServer } from "./gates.js";
import { ClientSessions } from "./client-sessions.js";

export interface McpHttpServerOptions {
	host: string;
	port: number;
	info: McpServerInfo;
	contextProvider: ToolContextProvider;
	/** Where the cause of a 500 goes; the wire carries none of it. */
	log?: Logger;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Lifecycle wrapper around the Node HTTP server that fronts the MCP endpoint. */
export class McpHttpServer {
	private server: http.Server | null = null;
	private readonly opts: McpHttpServerOptions;
	private readonly sessions = new ClientSessions();
	private readonly handler: McpHttpHandler;
	private readonly serveMcp: ReturnType<typeof toNodeHandler>;
	private readonly hostIsLoopback = localhostHostValidation();
	private readonly originIsLoopback = localhostOriginValidation();

	constructor(opts: McpHttpServerOptions) {
		this.opts = opts;
		this.handler = createMcpHandler(({ era, requestInfo }) => this.build(era, requestInfo), {
			// Nearly every report is a client's mistake (a wrong Accept or media
			// type, an unknown method), answered on the wire already. Vayu's own
			// fault is logged at `error` where it happens (`build`).
			onerror: (err) =>
				opts.log?.debug("mcp", "MCP request rejected", { error: err.message }),
		});
		this.serveMcp = toNodeHandler({
			fetch: (request, options) => this.serve(request, options),
		});
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
			const server = http.createServer((req, res) => {
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
		if (!server) return Promise.resolve();
		return closeServer(server);
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
		await this.serveMcp(req, res, body);
	}

	/** The web-standard face `toNodeHandler` calls: one request, both eras. */
	private async serve(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
		const response = await this.handler.fetch(request, options);
		const handshake = handshakeOf(options?.parsedBody);
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
 * The client named by a body that is an `initialize`, alone or as the
 * one-message batch the SDK also accepts. Read from the body rather than from a
 * server: the one that answered is gone with its request, and the stateless leg
 * runs no server that sees the `initialized` notification and the handshake
 * both. `isInitializeRequest` is the SDK's own schema check of the handshake, so
 * a name it passes is one the SDK accepted.
 */
function handshakeOf(body: unknown): { clientName: string } | undefined {
	const message = Array.isArray(body) && body.length === 1 ? body[0] : body;
	return isInitializeRequest(message)
		? { clientName: message.params.clientInfo.name }
		: undefined;
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
