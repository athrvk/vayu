/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Electron main-process constants.
 *
 * The main process is built separately from the renderer (tsconfig.node.json)
 * and cannot import renderer modules, so values shared with the UI — most
 * notably the engine port — are duplicated in src/config/network.ts. Keep
 * them in sync.
 */

// Engine sidecar (must match src/config/network.ts)
export const ENGINE_HOST = "127.0.0.1";
export const ENGINE_PORT = 9876;
/** Lock file written by the engine inside its data dir. */
export const ENGINE_LOCK_FILE = "vayu.lock";

// MCP server (Model Context Protocol) — a TypeScript sidecar hosted in this
// main process that exposes the engine's capabilities to agents (Claude Code,
// Codex, Cursor, …) over Streamable HTTP. Bound to loopback only. See
// docs/engine/mcp.md.
export const MCP_HOST = "127.0.0.1";
export const MCP_PORT = 9877;
/** URL agents connect to, e.g. `claude mcp add --transport http vayu <url>`. */
export const MCP_ENDPOINT_URL = `http://${MCP_HOST}:${MCP_PORT}/mcp`;

// Engine lifecycle
export const ENGINE_HEALTH_MAX_ATTEMPTS = 90;
export const ENGINE_HEALTH_POLL_INTERVAL_MS = 500;
export const ENGINE_HEALTH_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS = 2000;
export const ENGINE_GRACEFUL_EXIT_TIMEOUT_MS = 5000;
export const ENGINE_RESTART_MAX_RETRIES = 3;
export const ENGINE_RESTART_BASE_DELAY_MS = 1000;
/** Pause between stop and start during restart so the port is released. */
export const ENGINE_PORT_RELEASE_DELAY_MS = 500;

// Window
export const WINDOW_DEFAULT_WIDTH = 1400;
export const WINDOW_DEFAULT_HEIGHT = 900;
export const WINDOW_MIN_WIDTH = 1024;
export const WINDOW_MIN_HEIGHT = 768;
/** Custom titlebar overlay height. Must match TitleBar.tsx h-[38px]. */
export const TITLEBAR_HEIGHT = 38;
/** Debounce for persisting window bounds to disk. */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

// Dev server (must match vite.config.ts)
export const DEV_SERVER_URL = "http://localhost:5173";

// Project links
export const REPO = "athrvk/vayu";
export const DOCS_URL = `https://github.com/${REPO}#readme`;
export const SCRIPTING_DOCS_URL = `https://github.com/${REPO}/blob/master/docs/engine/scripting.md`;
export const ISSUES_URL = `https://github.com/${REPO}/issues`;

// Auto-updater
/** Re-check for updates every 6 hours while the app stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
