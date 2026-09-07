/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file listener.ts
 * @brief The MCP port, bound at launch, with the SDK behind it loaded by the
 *        first request that needs it.
 *
 * Starting the MCP server used to mean evaluating the SDK, zod and the tool
 * registry on every launch (#1145 took that off the path to the window; it
 * still ran after it), for a server most launches never receive a request on.
 * Measured on the packaged app at idle, that stack holds 5-7 MB of the main
 * process. So this module owns the socket and nothing else: it imports no SDK,
 * refuses what needs none (`gates.ts`), and asks `loadHandler` for the rest
 * the first time a `POST /mcp` arrives. An agent's first call pays the load
 * once; the port it connects to is the same one, bound since launch.
 *
 * A load that fails is not cached here: the next request asks again, and it is
 * the loader's business whether that can succeed (`main.ts`'s `loadMcp` caches
 * its own rejection, because a module missing from the asar is a broken
 * install). Concurrent first requests share one load.
 */

import http from "node:http";
import { MCP_PATH } from "../constants.js";
import { answerInternalError, answerUnlessMcpPost } from "./gates.js";

export type McpRequestHandler = (
	req: http.IncomingMessage,
	res: http.ServerResponse
) => Promise<void>;

export interface McpListenerOptions {
	host: string;
	port: number;
	/** Produces the handler that serves every `POST /mcp` from then on. */
	loadHandler: () => Promise<McpRequestHandler>;
}

export class McpListener {
	private server: http.Server | null = null;
	private handler: Promise<McpRequestHandler> | null = null;
	private readonly opts: McpListenerOptions;

	constructor(opts: McpListenerOptions) {
		this.opts = opts;
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
				this.dispatch(req, res).catch((err) => answerInternalError(res, err));
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

	private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (answerUnlessMcpPost(req, res)) return;
		const loading = (this.handler ??= this.opts.loadHandler().catch((err) => {
			if (this.handler === loading) this.handler = null;
			throw err;
		}));
		const handle = await loading;
		await handle(req, res);
	}
}
