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

		const body = await readJsonBody(req);

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

/** Read and JSON-parse the request body, tolerating an empty body. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (raw.trim() === "") {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
