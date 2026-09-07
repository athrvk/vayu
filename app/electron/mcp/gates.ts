/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file gates.ts
 * @brief The answers the MCP endpoint gives without the SDK: the wrong path,
 *        the wrong method, and a handler that threw past its own error paths.
 *
 * Shared by `listener.ts`, which binds the port at launch and must refuse a
 * stray GET before it pays to load the SDK, and `http.ts`, which answers the
 * same way once the SDK is up. One definition, so the two servers cannot drift
 * into answering a probe of `/` differently.
 */

import type http from "node:http";
import { MCP_PATH } from "../constants.js";

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

/** The 500 for an error nothing closer to the request answered. */
export function answerInternalError(res: http.ServerResponse, err: unknown): void {
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
}
