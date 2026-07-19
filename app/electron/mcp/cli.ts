/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file cli.ts
 * @brief Standalone stdio MCP server. Reuses the exact same tool registry and
 *        server factory as the Electron-hosted Streamable HTTP server, but over
 *        stdio — the transport stdio-only clients (Zed) and headless/CI setups
 *        need. Run: `node dist-electron/mcp/cli.js` (requires a running engine).
 *
 *        stdout is the JSON-RPC channel; all human logging goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { EngineClient } from "./engine-client.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { ToolContext } from "./tools.js";

function readSafetyFromEnv(): Partial<McpSafetyConfig> {
	const env = process.env;
	const cfg: Partial<McpSafetyConfig> = {};
	if (env.VAYU_MCP_ALLOWLIST) {
		cfg.allowlist = env.VAYU_MCP_ALLOWLIST.split(",")
			.map((h) => h.trim())
			.filter(Boolean);
	}
	if (env.VAYU_MCP_MAX_RPS) cfg.maxRps = Number(env.VAYU_MCP_MAX_RPS);
	if (env.VAYU_MCP_MAX_CONCURRENCY) cfg.maxConcurrency = Number(env.VAYU_MCP_MAX_CONCURRENCY);
	if (env.VAYU_MCP_MAX_DURATION_SECONDS)
		cfg.maxDurationSeconds = Number(env.VAYU_MCP_MAX_DURATION_SECONDS);
	if (env.VAYU_MCP_ALLOW_ALL === "true") cfg.allowAll = true;
	if (env.VAYU_MCP_ALLOW_WRITES === "true") cfg.allowWrites = true;
	return cfg;
}

async function main(): Promise<void> {
	const engineBaseUrl = process.env.VAYU_ENGINE_URL ?? "http://127.0.0.1:9876";
	const version = process.env.VAYU_VERSION ?? "0.0.0";

	const client = new EngineClient({ baseUrl: engineBaseUrl });
	const config = resolveSafetyConfig(readSafetyFromEnv());
	const contextProvider = (): ToolContext => ({ client, config });

	const server = createMcpServer({ name: "vayu", version }, contextProvider);
	const transport = new StdioServerTransport();

	await server.connect(transport);
	console.error(`[vayu-mcp] stdio server ready (engine: ${engineBaseUrl})`);
}

main().catch((err) => {
	console.error("[vayu-mcp] fatal:", err);
	process.exit(1);
});
