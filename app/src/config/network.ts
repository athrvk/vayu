/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UI-to-Engine Network Configuration
 *
 * The engine sidecar listens on a fixed local port (see engine docs and
 * app/electron/constants.ts - the electron main process duplicates the port
 * because it cannot import renderer modules).
 */

export const ENGINE_HOST = "127.0.0.1";
export const ENGINE_PORT = 9876;
export const ENGINE_BASE_URL = `http://${ENGINE_HOST}:${ENGINE_PORT}`;

/** Default timeout for UI-to-engine requests (local operations). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Calls that proxy a remote server (/request, /import/fetch) are bounded by
 * the engine's user-configurable `defaultTimeout` setting, not this client.
 * The UI timeout for those calls is derived as engine timeout + grace so the
 * engine's own TIMEOUT error (with proper error code) always arrives before
 * the UI aborts.
 */
export const PROXIED_TIMEOUT_GRACE_MS = 10_000;

/**
 * Upper bound of the engine's `defaultTimeout` setting (see
 * engine/src/db/database.cpp seed_default_config). Used as a safe fallback
 * when the config cache is cold.
 */
export const ENGINE_MAX_DEFAULT_TIMEOUT_MS = 300_000;

/** Page size when fetching time-series stats for a run. */
export const STATS_PAGE_LIMIT = 5000;

/**
 * Page size for the paginated `GET /runs` history list. The engine caps a page
 * at 500; the history sidebar polls only the first page (newest runs land on
 * page 1 under start_time DESC) and pages older runs in on demand.
 */
export const RUNS_PAGE_LIMIT = 50;

/**
 * Page size the MCP `list_runs` tool requests - a single bounded first page,
 * so an agent gets recent runs without downloading unbounded history.
 */
export const MCP_RUNS_PAGE_LIMIT = 100;
