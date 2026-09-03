/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Config Queries
 *
 * TanStack Query hooks for configuration operations, and for the one thing the
 * engine derives from config that a client cannot: what a send adds on its own.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
import type { GetConfigResponse, UpdateConfigRequest } from "@/types";

/**
 * Fetch all configuration entries
 */
export function useConfigQuery() {
	return useQuery({
		queryKey: queryKeys.config.all,
		queryFn: () => apiService.getConfig(),
		staleTime: QUERY_CACHE.CONFIG_STALE_TIME_MS, // Config rarely changes
	});
}

/**
 * What the engine will add to a request that names none of it (issue #1229) -
 * `User-Agent`, a negotiated `Accept-Encoding`, an optional correlation id.
 *
 * Read rather than derived: the *engine* decides the set (its libcurl decides
 * which encodings it can even ask for), so a client that worked it out from the
 * config entries would be a second definition of the same rule. Cached like
 * config, and for the same reason - it changes only when config does.
 */
export function useRequestDefaultsQuery() {
	return useQuery({
		queryKey: queryKeys.requestDefaults.all,
		queryFn: () => apiService.getRequestDefaults(),
		staleTime: QUERY_CACHE.CONFIG_STALE_TIME_MS,
	});
}

/**
 * Update configuration entries
 */
export function useUpdateConfigMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateConfigRequest) => apiService.updateConfig(data),
		onSuccess: (updatedConfig) => {
			// Update cache with new config
			queryClient.setQueryData<GetConfigResponse>(queryKeys.config.all, updatedConfig);
			// Four config entries decide what a send adds on its own
			// (`negotiateCompression`, `loadNegotiateCompression`,
			// `correlationIdEnabled`, `correlationIdHeader`), and the engine
			// resolves them - so the declared set has to be re-read rather than
			// patched from the entries written here.
			queryClient.invalidateQueries({ queryKey: queryKeys.requestDefaults.all });
		},
	});
}
