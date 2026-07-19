/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file server.ts
 * @brief Builds a configured MCP `Server` (official SDK) with the Vayu tool
 *        registry wired to `tools/list` and `tools/call`. Transport-agnostic:
 *        the same server is connected to a Streamable HTTP transport (Electron)
 *        or a stdio transport (CLI).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, dispatchTool, type ToolContext } from "./tools.js";

/** Provides the per-request tool context (client + current safety config). */
export type ToolContextProvider = () => ToolContext;

export interface McpServerInfo {
	name: string;
	version: string;
}

/**
 * Create an MCP `Server` exposing the Vayu tools. `contextProvider` is invoked
 * per call so the safety config can change at runtime (e.g. from Settings)
 * without rebuilding the server.
 */
export function createMcpServer(info: McpServerInfo, contextProvider: ToolContextProvider): Server {
	const server = new Server(
		{ name: info.name, version: info.version },
		{
			capabilities: { tools: {} },
			instructions:
				"Vayu exposes API testing, load testing, and engine configuration. Call " +
				"get_engine_health first. Tools are grouped as read (inspect collections, " +
				"runs, config, metrics), write (run_request, update_engine_config), and load " +
				"(start_load_run, stop_run, get_live_metrics, compare_runs). " +
				"Network-touching tools (run_request, start_load_run) are restricted to an " +
				"allowlist and hard rate/duration caps; start_load_run must be called with " +
				"confirmed:true to actually generate load. update_engine_config requires the " +
				"user to enable config writes. The user may disable individual tools, so treat " +
				"tools/list as authoritative and expect some tools to be absent.",
		}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const { config } = contextProvider();
		return {
			tools: TOOLS.filter((t) => !config.disabledTools.includes(t.name)).map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			})),
		};
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const result = await dispatchTool(
			name,
			(args ?? {}) as Record<string, unknown>,
			contextProvider()
		);
		// ToolResult is the plain {content, isError} shape; the SDK's CallToolResult
		// is a union whose other arm requires task fields we do not use.
		return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
	});

	return server;
}
