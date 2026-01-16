/**
 * Script Completions Query
 *
 * TanStack Query hook for fetching Monaco editor autocomplete data.
 */

import { useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";

/**
 * Fetch script completions for Monaco editor
 * These rarely change, so we cache for a long time.
 */
export function useScriptCompletionsQuery() {
	return useQuery({
		queryKey: queryKeys.scriptCompletions.all,
		queryFn: () => apiService.getScriptCompletions(),
		// Script completions don't change, cache for 1 hour
		staleTime: 60 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		// Don't retry if it fails - not critical
		retry: 1,
	});
}
