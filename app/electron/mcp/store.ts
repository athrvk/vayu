/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief Disk persistence for the MCP safety config, so an allowlist / caps the
 *        user sets in Settings survive an app restart. Main-process only (uses
 *        `userData` through `json-store.ts`) - the shared tool registry and the
 *        stdio CLI never import this; the CLI takes its config from environment
 *        variables.
 */

import { appLogger } from "../app-log.js";
import { ENGINE_PORT_CANDIDATES, MCP_PORT, MCP_PORT_MAX, MCP_PORT_MIN } from "../constants.js";
import { createJsonStore, type JsonStore } from "../json-store.js";
import { resolveSafetyConfig, sanitizeSafetyInput, type McpSafetyConfig } from "./config.js";

interface McpStoreShape {
	safety: Partial<McpSafetyConfig>;
	/** Whether the MCP server should run. Defaults to true when unset. */
	enabled: boolean;
	/** The port the server binds and the engine refuses to reach (#3580). `MCP_PORT` when unset. */
	port: number;
}

let store: JsonStore<McpStoreShape> | null = null;

// Lazily created so the store is only touched once `main.ts` has named
// `userData` (at module scope, ahead of anything that opens a file there). Each
// engine spawn reads it (`readMcpPort()`), the first one usually before
// `app.whenReady`, and so does the MCP lifecycle's start. So a corrupt
// mcp-config.json has to be an empty store rather than a throw, which would
// fail the engine start on every launch until the user found and deleted a
// hidden file. Every reader below resolves safe defaults from an empty store
// (locked-down safety config, server on, port 9877).
function getStore(): JsonStore<McpStoreShape> {
	store ??= createJsonStore<McpStoreShape>("mcp-config", undefined, (msg, fields) =>
		appLogger().warn("main", msg, fields)
	);
	return store;
}

/**
 * Where an unreadable mcp-config.json was kept when the first Settings change
 * replaced it (#2433), or null. Settings shows it: the reset to locked-down
 * defaults is otherwise silent.
 */
export function mcpConfigCorruptCopy(): string | null {
	return getStore().corruptCopy();
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

/** A value accepted as the MCP port, or why it was refused, in a sentence Settings shows. */
export type McpPortVerdict = { ok: true; port: number } | { ok: false; message: string };

/**
 * Whether `value` can be the MCP port. The engine's candidates are refused
 * because the engine refuses an `--mcp-port` equal to its own `--port`, and the
 * sidecar may land on any of them (#2118).
 */
export function validateMcpPort(value: unknown): McpPortVerdict {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { ok: false, message: "The MCP port has to be a whole number." };
	}
	if (value < MCP_PORT_MIN || value > MCP_PORT_MAX) {
		return {
			ok: false,
			message: `The MCP port has to be between ${MCP_PORT_MIN} and ${MCP_PORT_MAX}.`,
		};
	}
	if (ENGINE_PORT_CANDIDATES.includes(value)) {
		return { ok: false, message: `Port ${value} is reserved for Vayu's engine.` };
	}
	return { ok: true, port: value };
}

export interface McpPortReading {
	/** The configured port, or `MCP_PORT` when none is stored or the stored one is unusable. */
	port: number;
	/**
	 * Why a stored value was set aside for the default, for Settings to show; null
	 * when nothing was. Validated on read as well as on write because the file is
	 * hand-editable, and an unusable port would otherwise fail the engine's spawn.
	 */
	storedError: string | null;
}

/** The configured MCP port. Read at every engine spawn and every status. */
export function readMcpPort(): McpPortReading {
	const stored: unknown = getStore().get("port");
	if (stored === undefined) return { port: MCP_PORT, storedError: null };
	const verdict = validateMcpPort(stored);
	if (verdict.ok) return { port: verdict.port, storedError: null };
	return {
		port: MCP_PORT,
		storedError: `mcp-config.json sets the MCP port to ${JSON.stringify(stored)}, which isn't usable. ${verdict.message} Vayu is using the default, ${MCP_PORT}.`,
	};
}

/** Persist the MCP port if it is one Vayu can use; the verdict says which. */
export function saveMcpPort(value: unknown): McpPortVerdict {
	const verdict = validateMcpPort(value);
	if (verdict.ok) getStore().set("port", verdict.port);
	return verdict;
}
