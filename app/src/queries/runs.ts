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
import { ApiError } from "@/services";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
import { STATS_PAGE_LIMIT, RUNS_PAGE_LIMIT } from "@/config/network";
import type { Run, RunListResponse } from "@/types";
import type { TimeSeriesResponse } from "@/modules/history/types";

// ============ Run Queries ============

/** How often the unpaged run list re-asks the engine. */
const RUNS_POLL_MS = 5000;

/**
 * Polling is gated to the unpaged state on purpose.
 *
 * Refetching an infinite query re-fetches *every* loaded page in sequence, so a
 * user ten pages deep drove ~10 engine requests every 5s for as long as the
 * drawer stayed open. Only page 1 can gain rows anyway (`start_time DESC`), and
 * paging older runs in is an explicit act - once the user has done it the list
 * refreshes on the next mutation or invalidation instead of on a timer.
 */
export function runsPollInterval(loadedPages: number): number | false {
	return loadedPages > 1 ? false : RUNS_POLL_MS;
}

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
		refetchInterval: (query) => runsPollInterval(query.state.data?.pages.length ?? 0),
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
 * A run that the engine says is gone, as opposed to an engine that did not
 * answer. Deleting a run is permanent and its tab can outlive it (a persisted
 * tab rehydrates on the next launch), so the pane has to tell "this was
 * deleted - close the tab" from "the engine is down - try again". Callers
 * discriminate with `isRunNotFound`, never by matching the message.
 *
 * The same contract `RequestNotFoundError` carries for requests.
 */
export class RunNotFoundError extends Error {
	readonly runId: string;
	constructor(runId: string) {
		super(`Run ${runId} no longer exists`);
		this.name = "RunNotFoundError";
		this.runId = runId;
	}
}

/** True only for a genuine deletion, never for a transport failure. */
export function isRunNotFound(error: unknown): error is RunNotFoundError {
	return error instanceof RunNotFoundError;
}

/**
 * Fetch one run, including its configSnapshot and - for a design run - the
 * stored exchange. The report is a load-test aggregate and carries no
 * configuration for a design run, so this is the only source for it.
 */
/** See `requestDetailOptions` - same reason, for runs. */
export function runDetailOptions(runId: string | null) {
	return {
		queryKey: queryKeys.runs.detail(runId ?? ""),
		queryFn: async () => {
			try {
				return await apiService.getRun(runId!);
			} catch (error) {
				// A definitive deletion, distinct from a transport failure.
				if (error instanceof ApiError && error.statusCode === 404) {
					throw new RunNotFoundError(runId!);
				}
				throw error;
			}
		},
		enabled: !!runId,
		// Never retry a real deletion - a 404 is final, and a zombie run tab
		// retrying it forever is exactly what the global retry produced. A
		// transport failure still gets the default budget.
		retry: (count: number, error: unknown) =>
			!isRunNotFound(error) && count < QUERY_CACHE.DEFAULT_QUERY_RETRY,
		staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
	};
}

export function useRunQuery(runId: string | null) {
	return useQuery(runDetailOptions(runId));
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
		// Its own key family, not `runs.list(...)` - see `queryKeys.runs.lastDesign`.
		queryKey: queryKeys.runs.lastDesign(requestId ?? ""),
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
					// Belt to `runs.lastDesign`'s braces: a prefix patch must never
					// assume the shape of a cache it did not write. Anything that is
					// not paged is left alone rather than thrown on.
					if (!old || !Array.isArray(old.pages)) return old;
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
