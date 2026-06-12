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

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
			gcTime: QUERY_CACHE.DEFAULT_GC_TIME_MS,
			retry: QUERY_CACHE.DEFAULT_QUERY_RETRY,
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
