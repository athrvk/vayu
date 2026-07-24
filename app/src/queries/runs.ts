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

import {
	useQuery,
	useMutation,
	useQueryClient,
	useInfiniteQuery,
	type InfiniteData,
} from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
import { STATS_PAGE_LIMIT, RUNS_PAGE_LIMIT } from "@/config/network";
import type { Run, RunListResponse } from "@/types";
import type { TimeSeriesResponse } from "@/modules/history/types";

// ============ Run Queries ============

/**
 * Fetch run history as an infinite query over the `{data, pagination}`
 * envelope, newest first. The 5s `refetchInterval` keeps the loaded pages
 * fresh - in the default state that is just the first page, so new runs (which
 * land on page 1 under start_time DESC) appear without re-fetching older pages.
 * Older pages are fetched on demand via `fetchNextPage`.
 *
 * @param q Optional server-side substring search over the stored snapshot.
 *          Type/status/sort stay client-side (see history-store `filterRuns`).
 */
export function useRunsQuery(q?: string) {
	const search = q?.trim() || undefined;
	return useInfiniteQuery<RunListResponse, Error>({
		queryKey: queryKeys.runs.list({ q: search }),
		queryFn: ({ pageParam = 0 }) =>
			apiService.listRuns({ q: search, limit: RUNS_PAGE_LIMIT, offset: pageParam as number }),
		initialPageParam: 0,
		getNextPageParam: (lastPage) =>
			lastPage.pagination.hasMore
				? lastPage.pagination.offset + lastPage.pagination.limit
				: undefined,
		refetchInterval: 5000, // 5 seconds
	});
}

/**
 * Flatten an infinite runs query's pages into a de-duplicated list. Dedup by id
 * matters because offset pagination + head insertions (a new run prepends to
 * page 1) can momentarily place one run in two refetched pages; keeping the
 * first occurrence avoids a doubled row.
 */
export function flattenRunPages(data: InfiniteData<RunListResponse> | undefined): Run[] {
	if (!data) return [];
	const seen = new Set<string>();
	const runs: Run[] = [];
	for (const page of data.pages) {
		for (const run of page.data) {
			if (seen.has(run.id)) continue;
			seen.add(run.id);
			runs.push(run);
		}
	}
	return runs;
}

/** Total run count matching the query, from the first loaded page's envelope. */
export function runsTotal(data: InfiniteData<RunListResponse> | undefined): number {
	return data?.pages[0]?.pagination.total ?? 0;
}

/**
 * Fetch every run (all pages) as a flat list. For callers that need the whole
 * set rather than a polled page - counting and clearing history in Settings.
 * Not polled; rows carry the compact summary so it stays cheap.
 */
export function useAllRunsQuery() {
	return useQuery({
		queryKey: queryKeys.runs.allRuns(),
		queryFn: () => apiService.listAllRuns(),
	});
}

/**
 * Fetch one run, including its configSnapshot and - for a design run - the
 * stored exchange. The report is a load-test aggregate and carries no
 * configuration for a design run, so this is the only source for it.
 */
export function useRunQuery(runId: string | null) {
	return useQuery({
		queryKey: queryKeys.runs.detail(runId ?? ""),
		queryFn: () => apiService.getRun(runId!),
		enabled: !!runId,
		staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
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
		staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
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
			apiService.getRunTimeSeries(runId!, {
				limit: STATS_PAGE_LIMIT,
				offset: pageParam as number,
			}),
		enabled: !!runId,
		// Historical data never changes
		staleTime: Infinity,
		gcTime: QUERY_CACHE.RUNS_GC_TIME_MS,
		initialPageParam: 0,
		getNextPageParam: (lastPage) =>
			lastPage.pagination.hasMore
				? lastPage.pagination.offset + lastPage.pagination.limit
				: undefined,
	});
}

/**
 * Find the last completed design run for a specific request. One filtered
 * server call (`requestId`, `type=design`, `status=completed`, `limit=1`) -
 * the server already sorts start_time DESC, so the single row it returns is
 * the most recent. No client-side download-and-filter.
 */
export function useLastDesignRunQuery(requestId: string | null | undefined) {
	const { data, isLoading: runLoading } = useQuery({
		queryKey: queryKeys.runs.list({
			requestId: requestId ?? "",
			type: "design",
			status: "completed",
			limit: 1,
		}),
		queryFn: () =>
			apiService.listRuns({
				requestId: requestId!,
				type: "design",
				status: "completed",
				limit: 1,
			}),
		enabled: !!requestId,
	});

	const lastDesignRun = data?.data[0] ?? null;

	// Fetch the report for that run
	const { data: report, isLoading: reportLoading } = useRunReportQuery(lastDesignRun?.id || null);

	return {
		run: lastDesignRun,
		report,
		isLoading: runLoading || reportLoading,
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
			// Remove from every infinite-list cache variant (each search caches
			// separately). Patch the InfiniteData page shape in place: drop the
			// row and decrement the mirrored total so the count stays right.
			queryClient.setQueriesData<InfiniteData<RunListResponse>>(
				{ queryKey: queryKeys.runs.lists() },
				(old) => {
					if (!old) return old;
					return {
						...old,
						pages: old.pages.map((page) => {
							const data = page.data.filter((r) => r.id !== deletedId);
							if (data.length === page.data.length) return page;
							return {
								...page,
								data,
								pagination: {
									...page.pagination,
									total: Math.max(0, page.pagination.total - 1),
									returned: data.length,
								},
							};
						}),
					};
				}
			);
			// Keep the all-runs (Settings) cache in step.
			queryClient.setQueryData<Run[]>(
				queryKeys.runs.allRuns(),
				(old) => old?.filter((r) => r.id !== deletedId) ?? old
			);
			// Remove report from cache
			queryClient.removeQueries({
				queryKey: queryKeys.runs.report(deletedId),
			});
		},
	});
}

/**
 * Add a new run to the front of the first list page (after starting a load
 * test), so it shows immediately without waiting for the next poll.
 */
export function useAddRunToCache() {
	const queryClient = useQueryClient();

	return (newRun: Run) => {
		queryClient.setQueriesData<InfiniteData<RunListResponse>>(
			{ queryKey: queryKeys.runs.lists() },
			(old) => {
				if (!old || old.pages.length === 0) return old;
				const [first, ...rest] = old.pages;
				return {
					...old,
					pages: [
						{
							...first,
							data: [newRun, ...first.data],
							pagination: {
								...first.pagination,
								total: first.pagination.total + 1,
								returned: first.data.length + 1,
							},
						},
						...rest,
					],
				};
			}
		);
	};
}

/**
 * Invalidate every runs list (trigger refetch) - both the polled infinite list
 * and the all-runs Settings query.
 */
export function useInvalidateRuns() {
	const queryClient = useQueryClient();

	return () => {
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.allRuns() });
	};
}
