/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file store.ts
 * @brief Disk persistence for the MCP safety config, so an allowlist / caps the
 *        user sets in Settings survive an app restart. Main-process only (uses
 *        electron-store) — the shared tool registry and the stdio CLI never
 *        import this; the CLI takes its config from environment variables.
 */

import Store from "electron-store";
import { resolveSafetyConfig, sanitizeSafetyInput, type McpSafetyConfig } from "./config.js";

interface McpStoreShape {
	safety: Partial<McpSafetyConfig>;
	/** Whether the MCP server should run. Defaults to true when unset. */
	enabled: boolean;
}

let store: Store<McpStoreShape> | null = null;

// Lazily created so the store is only touched once Electron's `app` is ready and
// `userData` resolves — mirrors how window-state is persisted.
function getStore(): Store<McpStoreShape> {
	if (!store) store = new Store<McpStoreShape>({ name: "mcp-config" });
	return store;
}

/**
 * Load the persisted safety override, run it back through the sanitizer (guards
 * against a hand-edited or stale config file), and merge onto the safe defaults.
 */
export function loadPersistedSafety(): McpSafetyConfig {
	const saved = getStore().get("safety");
	return resolveSafetyConfig(sanitizeSafetyInput(saved ?? {}));
}

/** Persist the full, resolved safety config. */
export function savePersistedSafety(config: McpSafetyConfig): void {
	getStore().set("safety", config);
}

/** Whether the MCP server is enabled (defaults to true when never set). */
export function loadMcpEnabled(): boolean {
	const value = getStore().get("enabled");
	return typeof value === "boolean" ? value : true;
}

/** Persist the MCP server enabled/disabled preference. */
export function saveMcpEnabled(enabled: boolean): void {
	getStore().set("enabled", enabled);
}
