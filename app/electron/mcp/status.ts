/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file status.ts
 * @brief What `mcp:status` and `mcp:connectClient` answer, kept out of `main.ts`
 *        so the answers can be tested without Electron.
 *
 *        A server that is enabled but not listening used to be visible only in
 *        the app log, while Settings kept offering the connect URL: an agent
 *        pointed at it either failed or, worse, reached whatever other program
 *        held the port (#2368). The failure is therefore part of the status,
 *        and a client is never registered against a listener that is not up.
 *
 *        Electron-free and SDK-free on purpose: `main.ts` imports it eagerly
 *        (`startup-import-graph.test.ts`).
 */

import { MCP_ENDPOINT_URL } from "../constants.js";
import { connectClient } from "./connect.js";
import type { McpConnectClient, McpConnectResult } from "./connect.js";

/**
 * Why the server is enabled but not listening. Mirrored by `McpStartError` in
 * `src/types/domain.ts` (this tree cannot import it, see `tsconfig.node.json`);
 * `status.conformance.test.ts` holds the two together.
 */
export interface McpStartError {
	/** Only a bind failure gets a code of its own; anything else is `"other"`. */
	code: "EADDRINUSE" | "EACCES" | "other";
	message: string;
}

export interface McpStatus {
	running: boolean;
	url: string;
	enabled: boolean;
	/** Present only while the server is enabled and failed to start. */
	error?: McpStartError;
}

/** The slice of `McpListener` these answers read. */
export interface McpListenerState {
	url: string;
	isRunning(): boolean;
}

function errnoCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	return typeof err.code === "string" ? err.code : undefined;
}

/**
 * Sort a failed start into what the user can act on. `startMcp`'s catch also
 * sees a store or SDK-load failure, so only a bind error carrying the errno
 * gets the port wording; everything else is `"other"` with the error's own text.
 */
export function classifyStartError(
	err: unknown,
	endpoint: { host: string; port: number }
): McpStartError {
	const where = `${endpoint.host}:${endpoint.port}`;
	switch (errnoCode(err)) {
		case "EADDRINUSE":
			return { code: "EADDRINUSE", message: `Another program holds ${where}.` };
		case "EACCES":
			return { code: "EACCES", message: `Vayu isn't allowed to listen on ${where}.` };
		default:
			return {
				code: "other",
				message: `The MCP server couldn't start: ${err instanceof Error ? err.message : String(err)}`,
			};
	}
}

/**
 * The `mcp:status` answer. A listener that is up has no error to report even if
 * a stale one is passed; `url` falls back to the configured endpoint so Settings
 * can still name which port is affected.
 */
export function buildMcpStatus(state: {
	listener: McpListenerState | null;
	enabled: boolean;
	error: McpStartError | null;
}): McpStatus {
	const running = state.listener?.isRunning() ?? false;
	const status: McpStatus = {
		running,
		url: state.listener?.url ?? MCP_ENDPOINT_URL,
		enabled: state.enabled,
	};
	if (state.error && !running) status.error = state.error;
	return status;
}

/**
 * Register the endpoint with a client's CLI, but only against a live listener:
 * the configured URL is exactly what another program on the port would also
 * answer to. `connect` is a seam for the test.
 */
export async function connectWhileRunning(
	client: McpConnectClient,
	listener: McpListenerState | null,
	connect: typeof connectClient = connectClient
): Promise<McpConnectResult> {
	if (!listener?.isRunning()) {
		return {
			ok: false,
			reason: "not-running",
			message: "The MCP server isn't running, so there is no endpoint to register.",
		};
	}
	return connect(client, listener.url);
}
