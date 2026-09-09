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
 *        stdout is the JSON-RPC channel; all human logging goes to stderr,
 *        text always (#1558) - `VAYU_LOG_DIR`, unset by default, also gets a
 *        JSON-lines `mcp_<stamp>.log` there (its own prefix: this process
 *        shares no file with the Electron-hosted transport, which has no
 *        directory to hand it - a standalone `node dist-electron/mcp/cli.js`
 *        has no `app` module to derive one from).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { EngineClient } from "./engine-client.js";
import { buildSafetyConfigFromEnv, formatSafetyEnvNotices } from "./config.js";
import type { ToolContext } from "./tools.js";
import { createLogger, applyFloorFromEngine } from "../log.js";

async function main(): Promise<void> {
	const engineBaseUrl = process.env.VAYU_ENGINE_URL ?? "http://127.0.0.1:9876";
	const version = process.env.VAYU_VERSION ?? "0.0.0";

	const log = createLogger("mcp", {
		logsDir: process.env.VAYU_LOG_DIR ?? null,
		filePrefix: "mcp",
		consoleEnabled: true,
		consoleSplitByLevel: false,
	});
	void applyFloorFromEngine(log, engineBaseUrl);

	const client = new EngineClient({ baseUrl: engineBaseUrl });
	const envSafety = buildSafetyConfigFromEnv(process.env);
	const { config } = envSafety;
	for (const notice of formatSafetyEnvNotices(envSafety)) {
		log.warn("mcp", notice);
	}
	const contextProvider = (): ToolContext => ({ client, config, log });

	const server = createMcpServer({ name: "vayu", version }, contextProvider);
	const transport = new StdioServerTransport();

	await server.connect(transport);
	log.info("mcp", "stdio server ready", { engineBaseUrl });
}

main().catch((err) => {
	// The logger buffers until `applyFloorFromEngine` resolves, which a fatal
	// startup error can outrun - flush at `debug` so this is never lost.
	const log = createLogger("mcp", {
		logsDir: process.env.VAYU_LOG_DIR ?? null,
		filePrefix: "mcp",
		consoleEnabled: true,
		consoleSplitByLevel: false,
	});
	log.applyFloor("debug");
	log.error("mcp", "fatal", { error: String(err) });
	process.exit(1);
});
