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
 *        stdio - the transport stdio-only clients (Zed) and headless/CI setups
 *        need. Run: `node dist-electron/mcp/cli.js` (requires a running engine).
 *
 *        stdout is the JSON-RPC channel; all human logging goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { EngineClient } from "./engine-client.js";
import { buildSafetyConfigFromEnv, formatSafetyEnvNotices } from "./config.js";
import type { ToolContext } from "./tools.js";

async function main(): Promise<void> {
	const engineBaseUrl = process.env.VAYU_ENGINE_URL ?? "http://127.0.0.1:9876";
	const version = process.env.VAYU_VERSION ?? "0.0.0";

	const client = new EngineClient({ baseUrl: engineBaseUrl });
	const envSafety = buildSafetyConfigFromEnv(process.env);
	const { config } = envSafety;
	for (const notice of formatSafetyEnvNotices(envSafety)) {
		console.error(notice);
	}
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
