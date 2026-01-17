
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

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// Data considered fresh for 30 seconds
			staleTime: 30 * 1000,
			// Keep unused data in cache for 5 minutes
			gcTime: 5 * 60 * 1000,
			// Retry failed requests 2 times
			retry: 2,
			// Don't refetch on window focus for desktop app
			refetchOnWindowFocus: false,
			// Refetch on reconnect
			refetchOnReconnect: true,
		},
		mutations: {
			// Retry mutations once on failure
			retry: 1,
		},
	},
});
