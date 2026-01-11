/**
 * Runs Queries
 * 
 * TanStack Query hooks for run history operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { Run } from "@/types";

// ============ Run Queries ============

/**
 * Fetch all runs (history)
 */
export function useRunsQuery() {
	return useQuery({
		queryKey: queryKeys.runs.list(),
		queryFn: () => apiService.listRuns(),
	});
}

/**
 * Fetch a single run's report
 */
export function useRunReportQuery(runId: string | null) {
	return useQuery({
		queryKey: queryKeys.runs.report(runId ?? ""),
		queryFn: () => apiService.getRunReport(runId!),
		enabled: !!runId,
		// Reports don't change, cache longer
		staleTime: 5 * 60 * 1000,
	});
}

// ============ Run Mutations ============

/**
 * Delete a run
 */
export function useDeleteRunMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (runId: string) => apiService.deleteRun(runId),
		onSuccess: (_, deletedId) => {
			// Remove from cache
			queryClient.setQueryData<Run[]>(queryKeys.runs.list(), (old) =>
				old?.filter((r) => r.id !== deletedId) ?? []
			);
			// Remove report from cache
			queryClient.removeQueries({
				queryKey: queryKeys.runs.report(deletedId),
			});
		},
	});
}

/**
 * Add a new run to the cache (used after starting a load test)
 */
export function useAddRunToCache() {
	const queryClient = useQueryClient();

	return (newRun: Run) => {
		queryClient.setQueryData<Run[]>(queryKeys.runs.list(), (old) =>
			old ? [newRun, ...old] : [newRun]
		);
	};
}

/**
 * Invalidate runs list (trigger refetch)
 */
export function useInvalidateRuns() {
	const queryClient = useQueryClient();

	return () => {
		queryClient.invalidateQueries({
			queryKey: queryKeys.runs.list(),
		});
	};
}
