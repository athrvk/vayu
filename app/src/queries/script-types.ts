/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Script Type Definitions Query
 *
 * Fetches the engine-generated `.d.ts` for the `pm.*` surface. Cached on the
 * same terms as the completion list beside it: both are derived from one table
 * that only changes when the engine binary does.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";

export function useScriptTypeDefinitionsQuery() {
	return useQuery({
		queryKey: queryKeys.scriptTypes.all,
		queryFn: () => apiService.getScriptTypeDefinitions(),
		staleTime: QUERY_CACHE.SCRIPT_COMPLETIONS_STALE_TIME_MS,
		gcTime: QUERY_CACHE.SCRIPT_COMPLETIONS_GC_TIME_MS,
		// Not critical: without it the editor keeps completions and loses only
		// hover text and diagnostics, so a failure must not retry hard.
		retry: QUERY_CACHE.SCRIPT_COMPLETIONS_RETRY,
	});
}
