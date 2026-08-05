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
 *        electron-store) - the shared tool registry and the stdio CLI never
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
// `userData` resolves - mirrors how window-state is persisted.
function getStore(): Store<McpStoreShape> {
	if (!store)
		store = new Store<McpStoreShape>({
			name: "mcp-config",
			/*
			 * conf reads and parses the file inside its constructor and rethrows the
			 * SyntaxError when this flag is off - and this store is first touched
			 * during startup, before the window exists (main.ts's startMcp). A corrupt
			 * mcp-config.json would therefore leave the user with an engine running
			 * headless and no window at all, on every launch until they found and
			 * deleted a hidden file. Same fix, same reason as window-state.ts: an
			 * empty store is the right failure mode here, because both readers below
			 * resolve safe defaults from one (locked-down safety config, server on).
			 */
			clearInvalidConfig: true,
		});
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

/** The slice of `VayuMcpService` this module needs - structural, so the store
 *  stays importable without pulling in the server. */
interface SafetyHolder {
	getSafety(): McpSafetyConfig;
}

/**
 * The safety config Settings must display: the running server's when there is
 * one, the persisted config when there is not.
 *
 * The fallback cannot be `DEFAULT_MCP_SAFETY_CONFIG`. Settings adopts whatever
 * this returns as its source of truth and then commits *whole* fields computed
 * from it - adding a host commits `[...displayed, host]`. So handing a user with
 * MCP switched off (or a failed port bind) an empty allowlist means their next
 * edit persists a list of one and silently drops the rest. Both `updateSafety`
 * branches persist what they apply, so the persisted config is what the server
 * would be running.
 */
export function effectiveSafety(service: SafetyHolder | null | undefined): McpSafetyConfig {
	return service?.getSafety() ?? loadPersistedSafety();
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
