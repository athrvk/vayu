/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Script Completions Query
 *
 * TanStack Query hook for fetching Monaco editor autocomplete data.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";

/**
 * Fetch script completions for Monaco editor
 * These rarely change, so we cache for a long time.
 */
export function useScriptCompletionsQuery() {
	return useQuery({
		queryKey: queryKeys.scriptCompletions.all,
		queryFn: () => apiService.getScriptCompletions(),
		// Script completions don't change, cache for a long time
		staleTime: QUERY_CACHE.SCRIPT_COMPLETIONS_STALE_TIME_MS,
		gcTime: QUERY_CACHE.SCRIPT_COMPLETIONS_GC_TIME_MS,
		// Don't retry hard if it fails - not critical
		retry: QUERY_CACHE.SCRIPT_COMPLETIONS_RETRY,
	});
}
