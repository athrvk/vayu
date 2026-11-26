/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief What `mcp:status` and `mcp:connectClient` answer, kept out of `main.ts` so the answers can
 *        be tested without Electron.
 *
 * A server that is enabled but not listening is otherwise visible only in the app log while
 * Settings keeps offering the connect URL: an agent pointed at it either fails or, worse, reaches
 * whatever other program holds the port (#2368). The failure is therefore part of the status, and a
 * client is never registered against a listener that is not up.
 *
 * Electron-free and SDK-free on purpose: `main.ts` imports it eagerly
 * (`startup-import-graph.test.ts`).
 */

import { mcpEndpointUrl } from "../constants.js";
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
	/** The listener's endpoint, or while none is up the one the port in force names. */
	url: string;
	enabled: boolean;
	/** The configured port: what Settings shows and `mcp:setPort` saved (#3580). */
	port: number;
	/**
	 * The configured port is not in force yet. The engine learns the port only at
	 * spawn, so the server keeps (or would bind) the one the running engine was
	 * started with until the engine restarts. Mirrored in `src/types/domain.ts`.
	 */
	restartRequired: boolean;
	/**
	 * Enabled, with no listener and no failure to report: the start has not
	 * finished (or, before launch reaches it, has not begun), so there is nothing
	 * wrong yet and nothing to retry (#3579). Mirrored in `src/types/domain.ts`.
	 */
	starting: boolean;
	/** Present only while the server is enabled and failed to start. */
	error?: McpStartError;
	/**
	 * Where an unreadable `mcp-config.json` was kept after Settings replaced it
	 * (#2433). Independent of `running`: a disabled server still lost its config.
	 */
	corruptCopy?: string;
	/** Why the port stored in `mcp-config.json` was set aside for the default. */
	storedPortError?: string;
}

/** The `mcp:setPort` answer: the status the saved port leads to, or why it was refused. */
export type McpSetPortResult = { ok: true; status: McpStatus } | { ok: false; message: string };

/** What the status says about the port. */
export interface McpPortState {
	/** The configured port (`readMcpPort`). */
	configured: number;
	/** The port the server holds or last tried, else the one the running engine guards. */
	inForce: number;
	/** `readMcpPort`'s note about an unusable stored value, or null. */
	storedError: string | null;
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
 * Sort a failed start into what the user can act on. The lifecycle's start
 * also sees a store failure, so only a bind error carrying the errno gets the
 * port wording; everything else is `"other"` with the error's own text.
 * `endpoint` is null when the start failed before it had one to bind.
 */
export function classifyStartError(
	err: unknown,
	endpoint: { host: string; port: number } | null
): McpStartError {
	const where = endpoint ? `${endpoint.host}:${endpoint.port}` : "";
	switch (endpoint ? errnoCode(err) : undefined) {
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
 * a stale one is passed; `url` falls back to the endpoint of the port in force so
 * Settings can still name which port is affected.
 *
 * `starting` is derived rather than stored: the lifecycle publishes a listener
 * only once it is bound and a failure only once the bind has thrown, so an
 * enabled server with neither is one that has not finished starting.
 */
export function buildMcpStatus(state: {
	listener: McpListenerState | null;
	enabled: boolean;
	error: McpStartError | null;
	corruptCopy: string | null;
	port: McpPortState;
}): McpStatus {
	const running = state.listener?.isRunning() ?? false;
	const status: McpStatus = {
		running,
		url: state.listener?.url ?? mcpEndpointUrl(state.port.inForce),
		enabled: state.enabled,
		port: state.port.configured,
		restartRequired: state.port.configured !== state.port.inForce,
		starting: state.enabled && !state.listener && !state.error,
	};
	if (state.error && !running) status.error = state.error;
	if (state.corruptCopy) status.corruptCopy = state.corruptCopy;
	if (state.port.storedError) status.storedPortError = state.port.storedError;
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
