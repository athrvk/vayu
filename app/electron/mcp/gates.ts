/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief The answers the MCP endpoint gives without the SDK: the wrong path,
 *        the wrong method, and a handler that threw past its own error paths;
 *        and the server that holds the port, with how it closes.
 *
 * Shared by `listener.ts`, which binds the port at launch and must refuse a
 * stray GET before it pays to load the SDK, and `http.ts`, which answers the
 * same way once the SDK is up. One definition, so the two servers cannot drift
 * into answering a probe of `/` differently, or into closing differently.
 */

import http from "node:http";
import { MCP_PATH } from "../constants.js";
import type { Logger } from "../log.js";

/**
 * An HTTP server for the MCP port, passing every request to @p onRequest.
 * Node's `close()` closes only the connections idle at that moment; one still
 * answering would then stay open for `keepAliveTimeout` after its answer and
 * hold the close back (#3575). So once the server has stopped listening, each
 * response that finishes closes its own connection after the answer is
 * flushed, when its request was read in full. One whose request is still
 * arriving (an oversized upload, answered 413 before it ends) is only
 * half-closed, so the rest is drained rather than reset under the answer, and
 * the connection goes when the client closes its side. Not
 * `closeIdleConnections()` there: it destroys the socket at once, and lost the
 * answer when probed. Not `closeAllConnections()` at close either: a request
 * still arriving is answered.
 */
export function createMcpSocketServer(onRequest: http.RequestListener): http.Server {
	const server = http.createServer(onRequest);
	server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
		res.once("finish", () => {
			if (server.listening) return;
			if (req.complete) req.socket.destroySoon();
			else req.socket.end();
		});
	});
	return server;
}

function jsonRpcError(
	res: http.ServerResponse,
	status: number,
	headers: Record<string, string>,
	code: number,
	message: string
): void {
	res.writeHead(status, { "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Answer a request that is not a `POST /mcp`, and say so; false when it is one
 * and the caller should go on to serve it.
 */
export function answerUnlessMcpPost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
	const url = req.url ?? "";
	if (!url.startsWith(MCP_PATH)) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found. The MCP endpoint is at /mcp." }));
		return true;
	}
	// Stateless mode: GET/DELETE (session streams) are not supported.
	if (req.method !== "POST") {
		jsonRpcError(
			res,
			405,
			{ Allow: "POST" },
			-32000,
			"Method not allowed. This endpoint is POST-only."
		);
		return true;
	}
	return false;
}

/**
 * The 500 for an error nothing closer to the request answered. The wire says
 * only "Internal error": this response goes to anyone who can reach the port,
 * and a thrown message can carry a path or an engine URL. The cause goes to the
 * log instead.
 */
export function answerInternalError(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	err: unknown,
	log?: Logger
): void {
	log?.error("mcp", "Unhandled error serving an MCP request", {
		path: req.url ?? "",
		error: err instanceof Error ? (err.stack ?? err.message) : String(err),
	});
	if (!res.headersSent) {
		res.writeHead(500, { "Content-Type": "application/json" });
	}
	res.end(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32603, message: "Internal error" },
			id: null,
		})
	);
}
