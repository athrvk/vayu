/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UI Timing Configuration
 *
 * All UI-facing delays, debounces, polling intervals and retry policies in
 * one place. Values are milliseconds unless the name says otherwise.
 */

export const TIMING = {
	/** Debounced auto-save after the user stops editing a request. */
	AUTO_SAVE_DELAY_MS: 3000,
	/** How long the "Saved" indicator stays visible after a save. */
	SAVED_STATUS_DURATION_MS: 3000,

	/** Transient status feedback (copied / saved / error chips) reset delay. */
	STATUS_RESET_MS: 2000,

	/** Radix tooltip open delay used across the app. */
	TOOLTIP_DELAY_MS: 150,

	/** Engine health poll interval while the app is open. */
	HEALTH_CHECK_INTERVAL_MS: 30_000,

	/** Wait after asking electron to restart the engine before refetching. */
	ENGINE_RESTART_WAIT_MS: 1500,

	/** GraphQL editor diagnostics debounce. */
	GRAPHQL_DIAGNOSTICS_DEBOUNCE_MS: 250,
	/** GraphQL schema introspection debounce after URL/headers change. */
	GRAPHQL_INTROSPECTION_DEBOUNCE_MS: 400,

	/** Run report polling: first attempt delay, retry delay, and max attempts. */
	REPORT_INITIAL_DELAY_MS: 3000,
	REPORT_RETRY_DELAY_MS: 1000,
	REPORT_MAX_ATTEMPTS: 5,
} as const;
