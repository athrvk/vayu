/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TanStack Query Cache Configuration
 *
 * Centralized staleTime / gcTime / retry policies. Per-query overrides should
 * pull from here instead of hardcoding durations.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const QUERY_CACHE = {
	/** Defaults applied via the shared QueryClient. */
	DEFAULT_STALE_TIME_MS: 30 * SECOND,
	DEFAULT_GC_TIME_MS: 5 * MINUTE,
	DEFAULT_QUERY_RETRY: 2,
	DEFAULT_MUTATION_RETRY: 1,

	/** Engine /config rarely changes while the app is open. */
	CONFIG_STALE_TIME_MS: 1 * MINUTE,

	/** Completed runs are immutable; cache them aggressively. */
	RUNS_STALE_TIME_MS: 5 * MINUTE,
	RUNS_GC_TIME_MS: 30 * MINUTE,

	/** Script completion metadata is static per engine version. */
	SCRIPT_COMPLETIONS_STALE_TIME_MS: 1 * HOUR,
	SCRIPT_COMPLETIONS_GC_TIME_MS: 1 * HOUR,
	SCRIPT_COMPLETIONS_RETRY: 1,

	/** Looking a request up in the cache retries quickly while it populates. */
	REQUEST_LOOKUP_RETRY: 3,
	REQUEST_LOOKUP_RETRY_DELAY_MS: 100,
} as const;
