/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file http.ts
 * @brief Hosts the MCP server over Streamable HTTP on loopback. Each POST /mcp
 *        is handled statelessly (fresh Server + transport per request), which
 *        suits a low-traffic local proxy and avoids session bookkeeping. DNS
 *        rebinding protection is enabled so a browser tab cannot reach the
 *        endpoint via a forged Host header (MCP spec requirement).
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type McpServerInfo, type ToolContextProvider } from "./server.js";

export interface McpHttpServerOptions {
	host: string;
	port: number;
	info: McpServerInfo;
	contextProvider: ToolContextProvider;
}

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Lifecycle wrapper around the Node HTTP server that fronts the MCP endpoint. */
export class McpHttpServer {
	private server: http.Server | null = null;
	private readonly opts: McpHttpServerOptions;
	private readonly allowedHosts: string[];

	constructor(opts: McpHttpServerOptions) {
		this.opts = opts;
		this.allowedHosts = [`${opts.host}:${opts.port}`, `localhost:${opts.port}`];
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
				this.handle(req, res).catch((err) => {
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "application/json" });
					}
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32603, message: `Internal error: ${String(err)}` },
							id: null,
						})
					);
				});
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
		return new Promise((resolve) => server.close(() => resolve()));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = req.url ?? "";
		if (!url.startsWith(MCP_PATH)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found. The MCP endpoint is at /mcp." }));
			return;
		}

		// Stateless mode: GET/DELETE (session streams) are not supported.
		if (req.method !== "POST") {
			res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Method not allowed. This endpoint is POST-only.",
					},
					id: null,
				})
			);
			return;
		}

		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			// A client-side payload mistake is the client's, not a Vayu crash: the
			// generic catch in `start()` would answer 500 / -32603 ("Internal
			// error"), which reads as the server having fallen over. The SDK's own
			// parse-error path is unreachable here because the body is parsed
			// before the transport sees it, so the codes are answered directly.
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

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
			enableDnsRebindingProtection: true,
			allowedHosts: this.allowedHosts,
		});
		const server = createMcpServer(this.opts.info, this.opts.contextProvider);
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}
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
