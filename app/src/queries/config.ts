
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Config Queries
 *
 * TanStack Query hooks for configuration operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { GetConfigResponse, UpdateConfigRequest } from "@/types";

/**
 * Fetch all configuration entries
 */
export function useConfigQuery() {
	return useQuery({
		queryKey: queryKeys.config.all,
		queryFn: () => apiService.getConfig(),
		staleTime: 60 * 1000, // Config rarely changes
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
		},
	});
}
