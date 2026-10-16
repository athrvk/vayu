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

import type http from "node:http";
import { EngineClient } from "./engine-client.js";
import { McpHttpServer } from "./http.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { listedToolNames, type McpDataChangedEvent, type ToolContext } from "./tools.js";
import type { Logger } from "../log.js";
import type { AppFocus } from "../app-focus.js";
import type { DataFileLocation } from "../data-file-locations.js";

export interface VayuMcpServiceOptions {
	engineBaseUrl: string;
	host: string;
	port: number;
	version: string;
	safety?: Partial<McpSafetyConfig>;
	/**
	 * Called when a successful tool call changed engine data, so the owner can
	 * forward it to the renderer. Omitted when there is no renderer to tell.
	 */
	onDataChanged?: (event: McpDataChangedEvent) => void;
	/** Where a served call is logged (#1558), `src: "mcp"`. */
	log?: Logger;
	/** Where a collection's declared data file lives on this machine (#1742). */
	dataFileLocation?: (collectionId: string) => DataFileLocation | undefined;
	/** The SHA-256 of a remembered data file as it is now (#2051); rejects when unreadable. */
	currentDataFileHash?: (filePath: string) => Promise<string>;
	/** Which tab and environment the app window has open (#2045). */
	appFocus?: () => AppFocus | undefined;
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
			log: opts.log,
			contextProvider: (): ToolContext => ({
				client: this.client,
				config: this.config,
				onDataChanged: opts.onDataChanged,
				log: opts.log,
				dataFileLocation: opts.dataFileLocation,
				currentDataFileHash: opts.currentDataFileHash,
				appFocus: opts.appFocus,
			}),
		});
	}

	start(): Promise<void> {
		return this.httpServer.start();
	}

	/** Close the socket this service bound, if any, ending its open streams first. */
	stop(): Promise<void> {
		return this.httpServer.stop();
	}

	isRunning(): boolean {
		return this.httpServer.isRunning();
	}

	/** Serve one request on a socket this service does not own (`listener.ts`). */
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		return this.httpServer.handleRequest(req, res);
	}

	getUrl(): string {
		return this.httpServer.url;
	}

	/**
	 * Replace the safety config at runtime (e.g. when Settings change). The next
	 * request is served under it either way; a change to what `tools/list`
	 * answers is also announced, to the clients that can hear it.
	 */
	updateSafety(override: Partial<McpSafetyConfig>): void {
		const listed = listedToolNames(this.config).join(",");
		this.config = resolveSafetyConfig({ ...this.config, ...override });
		if (listedToolNames(this.config).join(",") !== listed) this.httpServer.notifyToolsChanged();
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
	effectiveSafety,
	loadMcpEnabled,
	saveMcpEnabled,
} from "./store.js";
export { connectClient } from "./connect.js";
export type { McpConnectClient, McpConnectResult } from "./connect.js";
export { toolCatalog, MCP_DATA_ENTITIES } from "./tools.js";
export type { McpToolInfo, ToolCategory, McpDataEntity, McpDataChangedEvent } from "./tools.js";
