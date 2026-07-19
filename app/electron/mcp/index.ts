/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file index.ts
 * @brief Public facade for the MCP feature. `VayuMcpService` owns the engine
 *        client, the mutable safety config, and the Streamable HTTP server, and
 *        is driven by the Electron main process (start/stop/status). See
 *        docs/engine/mcp.md.
 */

import { EngineClient } from "./engine-client.js";
import { McpHttpServer } from "./http.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { ToolContext } from "./tools.js";

export interface VayuMcpServiceOptions {
	engineBaseUrl: string;
	host: string;
	port: number;
	version: string;
	safety?: Partial<McpSafetyConfig>;
}

export class VayuMcpService {
	private readonly client: EngineClient;
	private config: McpSafetyConfig;
	private readonly httpServer: McpHttpServer;

	constructor(opts: VayuMcpServiceOptions) {
		this.client = new EngineClient({ baseUrl: opts.engineBaseUrl });
		this.config = resolveSafetyConfig(opts.safety);
		this.httpServer = new McpHttpServer({
			host: opts.host,
			port: opts.port,
			info: { name: "vayu", version: opts.version },
			contextProvider: (): ToolContext => ({ client: this.client, config: this.config }),
		});
	}

	start(): Promise<void> {
		return this.httpServer.start();
	}

	stop(): Promise<void> {
		return this.httpServer.stop();
	}

	isRunning(): boolean {
		return this.httpServer.isRunning();
	}

	getUrl(): string {
		return this.httpServer.url;
	}

	/** Replace the safety config at runtime (e.g. when Settings change). */
	updateSafety(override: Partial<McpSafetyConfig>): void {
		this.config = resolveSafetyConfig({ ...this.config, ...override });
	}

	getSafety(): McpSafetyConfig {
		return this.config;
	}
}

export { DEFAULT_MCP_SAFETY_CONFIG, resolveSafetyConfig, sanitizeSafetyInput } from "./config.js";
export type { McpSafetyConfig } from "./config.js";
export {
	loadPersistedSafety,
	savePersistedSafety,
	loadMcpEnabled,
	saveMcpEnabled,
} from "./store.js";
export { connectClient } from "./connect.js";
export type { McpConnectClient, McpConnectResult } from "./connect.js";
export { toolCatalog } from "./tools.js";
export type { McpToolInfo, ToolCategory } from "./tools.js";
