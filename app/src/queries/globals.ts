/**
 * Globals Queries
 * 
 * TanStack Query hooks for global variables operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { GlobalVariables, VariableValue } from "@/types";

/**
 * Fetch global variables
 */
export function useGlobalsQuery() {
	return useQuery({
		queryKey: queryKeys.globals.all,
		queryFn: () => apiService.getGlobals(),
	});
}

/**
 * Update global variables
 */
export function useUpdateGlobalsMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: { variables: Record<string, VariableValue> }) =>
			apiService.updateGlobals(data.variables),
		onSuccess: (updatedGlobals) => {
			// Update cache
			queryClient.setQueryData<GlobalVariables>(
				queryKeys.globals.all,
				updatedGlobals
			);
		},
	});
}
