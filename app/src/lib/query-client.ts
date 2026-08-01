/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TanStack Query Client Configuration
 *
 * Centralized QueryClient setup with sensible defaults for Vayu.
 */

import { QueryClient } from "@tanstack/react-query";
import { QUERY_CACHE } from "@/config/cache";
import { ApiError } from "@/services/http-client";

/**
 * A 4xx from the engine is a verdict, not a hiccup: a 404 for a deleted row
 * answers the same way three times in a row, and retrying it only delays the
 * error the caller is waiting for. Anything else - a 5xx, a timeout, an
 * unreachable engine - keeps the default budget, because those do recover.
 *
 * Exported so a query with its own retry rule can be checked against this one.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
	if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500) {
		return false;
	}
	return failureCount < QUERY_CACHE.DEFAULT_QUERY_RETRY;
}

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
			gcTime: QUERY_CACHE.DEFAULT_GC_TIME_MS,
			retry: shouldRetryQuery,
			// Don't refetch on window focus for desktop app
			refetchOnWindowFocus: false,
			// Refetch on reconnect
			refetchOnReconnect: true,
		},
		mutations: {
			retry: QUERY_CACHE.DEFAULT_MUTATION_RETRY,
		},
	},
});
