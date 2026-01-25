
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Runs Queries
 *
 * TanStack Query hooks for run history operations.
 */

import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { Run } from "@/types";
import type { TimeSeriesResponse } from "@/modules/history/types";

// ============ Run Queries ============

/**
 * Fetch all runs (history)
 */
export function useRunsQuery() {
	return useQuery({
		queryKey: queryKeys.runs.list(),
		queryFn: () => apiService.listRuns(),
		refetchInterval: 5000, // 5 seconds
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

/**
 * Fetch time-series metrics for a run (paginated, auto-fetches all pages)
 * Used for rendering historical charts in load test detail view.
 */
export function useRunTimeSeriesQuery(runId: string | null) {
	return useInfiniteQuery<TimeSeriesResponse, Error>({
		queryKey: queryKeys.runs.timeSeries(runId ?? ""),
		queryFn: ({ pageParam = 0 }) =>
			apiService.getRunTimeSeries(runId!, { limit: 5000, offset: pageParam as number }),
		enabled: !!runId,
		// Historical data never changes
		staleTime: Infinity,
		gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
		initialPageParam: 0,
		getNextPageParam: (lastPage) =>
			lastPage.pagination.hasMore
				? lastPage.pagination.offset + lastPage.pagination.limit
				: undefined,
	});
}

/**
 * Find the last design run for a specific request
 * Returns the most recent completed design run and its report
 */
export function useLastDesignRunQuery(requestId: string | null | undefined) {
	const { data: runs = [] } = useRunsQuery();

	// Find the most recent completed design run for this request
	const lastDesignRun = requestId
		? runs
				.filter(
					(r) =>
						r.type === "design" && r.requestId === requestId && r.status === "completed"
				)
				.sort((a, b) => b.startTime - a.startTime)[0] || null
		: null;

	// Fetch the report for that run
	const { data: report, isLoading } = useRunReportQuery(lastDesignRun?.id || null);

	return {
		run: lastDesignRun,
		report,
		isLoading,
	};
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
			queryClient.setQueryData<Run[]>(
				queryKeys.runs.list(),
				(old) => old?.filter((r) => r.id !== deletedId) ?? []
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
