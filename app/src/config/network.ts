/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UI-to-Engine Network Configuration
 *
 * The engine sidecar listens on 9876 unless another program holds it, in which
 * case the main process picks a fallback and tells the renderer once, as
 * `electronAPI.enginePort` (#2118; the candidate list is
 * app/electron/constants.ts, which the main process owns because it cannot
 * import renderer modules). The preload sets that value before any renderer
 * script runs, so resolving it at module load is complete.
 */

/** The engine's default port, and the answer wherever there is no preload. */
export const DEFAULT_ENGINE_PORT = 9876;

/**
 * The port the preload reports, or the default when there is no preload (a
 * browser tab, the test suite) or it reports something that is not a port.
 */
export function resolveEnginePort(api: { enginePort?: number | null } | undefined): number {
	const port = api?.enginePort;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		return DEFAULT_ENGINE_PORT;
	}
	return port;
}

export const ENGINE_HOST = "127.0.0.1";
export const ENGINE_PORT = resolveEnginePort(
	typeof window === "undefined" ? undefined : window.electronAPI
);
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
 * How many points the History view asks `GET /runs/:id/metrics?maxPoints=` for
 * (#2547). A run with at most this many ticks (about 33 minutes at the engine's
 * one tick a second) comes back raw; a longer one comes back folded into this
 * many buckets, so a 24 h soak is one response of about 2,000 ticks instead of
 * 18 pages of 5,000. Two or more, so a bucketed series always has the two
 * points a chart needs. The same budget is the `maxPoints` of the run's
 * server-vitals read (`GET /runs/:id/monitor`, #2611).
 */
export const HISTORY_SERIES_MAX_POINTS = 2000;

/**
 * Page size for `GET /runs/:id/samples`. The report itself serialises at most
 * 100 result rows, so one page covers every sample a surface can show; the
 * engine caps a page at 500 either way.
 */
export const RUN_SAMPLES_PAGE_LIMIT = 100;

/**
 * Page size for the paginated `GET /runs` history list. The engine caps a page
 * at 500; the history sidebar polls only the first page (newest runs land on
 * page 1 under start_time DESC) and pages older runs in on demand.
 */
export const RUNS_PAGE_LIMIT = 50;

/**
 * Page size for `GET /inbox/:id/requests`. This is the "what arrived recently"
 * window the surface opens with; the live stream appends past it. Not a mirror
 * of the engine's retention - that is the `inboxMaxCaptures` setting, which
 * caps how large a page may be asked for, not how large one is worth fetching.
 */
export const INBOX_CAPTURES_PAGE_LIMIT = 50;
