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
import type { Run, RunListResponse, StartScenarioRunRequest } from "@/types";
import type { MonitorSeriesResponse, TimeSeriesResponse } from "@/modules/history/types";

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
 * Fetch a run's captured response exchanges, indexed by result id.
 *
 * `enabled` is the point of this hook: the bodies are not part of the report
 * and must not be fetched with it - a surface passes `true` only once a reader
 * has expanded a sample. Returns a Map so a card can look its own exchange up
 * in constant time instead of scanning the page.
 *
 * Captured data never changes after a run finishes, so it is cached like the
 * time series rather than the polled report.
 */
export function useRunSamplesQuery(runId: string | null, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.runs.samples(runId ?? ""),
		queryFn: async () => {
			const page = await apiService.getRunSamples(runId!);
			return new Map(page.data.map((sample) => [sample.resultId, sample]));
		},
		enabled: !!runId && enabled,
		staleTime: Infinity,
		gcTime: QUERY_CACHE.RUNS_GC_TIME_MS,
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
 * Fetch the server vitals scraped during a run (paginated, auto-fetches all
 * pages), for the history view's overlay.
 *
 * Its own query beside {@link useRunTimeSeriesQuery} rather than a field on it:
 * the two series come from different endpoints and different cadences, and a
 * run that configured no monitor must not pay a second fetch it would only ever
 * read as empty - which is what `enabled` expresses at the call site.
 */
export function useRunMonitorSeriesQuery(runId: string | null, enabled = true) {
	return useInfiniteQuery<MonitorSeriesResponse, Error>({
		queryKey: queryKeys.runs.monitorSeries(runId ?? ""),
		queryFn: ({ pageParam = 0 }) =>
			apiService.getRunMonitorSeries(runId!, {
				limit: STATS_PAGE_LIMIT,
				offset: pageParam as number,
			}),
		enabled: !!runId && enabled,
		// A finished run's scrapes never change, like its time series.
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

/**
 * How many recent sends the context bar's trend shows. Small on purpose: the
 * section answers "has this been failing, is it getting slower" at a glance,
 * and History is where a longer list belongs.
 */
export const RECENT_DESIGN_RUN_LIMIT = 5;

/**
 * The last few design runs of one request, newest first - the rows behind the
 * context bar's Recent sends section.
 *
 * **One list call and no report fetch.** Each row carries its own
 * `resultSummary` (status code + latency) from the engine, which is the change
 * that made this section affordable: the alternative was one `GET /runs/:id/report`
 * per row, and that path loads and parses every result's `trace_data`.
 *
 * Deliberately **unfiltered by status**, unlike {@link useLastDesignRunQuery}:
 * a failed send is exactly what a trend is for, and `status` takes one value,
 * so filtering to `completed` would hide every failure. A run still in flight
 * comes back too, with no `resultSummary`; the section renders its status
 * rather than inventing an outcome for it.
 */
export function useRecentDesignRunsQuery(requestId: string | null | undefined) {
	return useQuery({
		// Its own key family, not `runs.list(...)` - see `queryKeys.runs.recentDesigns`.
		queryKey: queryKeys.runs.recentDesign(requestId ?? ""),
		queryFn: () =>
			apiService.listRuns({
				requestId: requestId!,
				type: "design",
				limit: RECENT_DESIGN_RUN_LIMIT,
			}),
		enabled: !!requestId,
	});
}

/**
 * The most recent run of one collection - the row behind the context bar's
 * Last run section.
 *
 * **One filtered call, one row.** `collectionId` is matched engine-side against
 * the scenario snapshot's own field, so the server's `start_time DESC` order
 * makes `limit: 1` the answer directly. The alternative this replaces is why the
 * section did not exist: without the filter, finding a collection's last run
 * meant paging the whole history and searching each snapshot's text for the id.
 *
 * Deliberately **unfiltered by status**, for the same reason `useRecentDesignRunsQuery`
 * is: a run that failed is the one worth surfacing, and `status` takes a single
 * value. A run still in flight comes back too; the section says so rather than
 * calling it an outcome.
 */
export function useLastCollectionRunQuery(collectionId: string | null | undefined) {
	return useQuery({
		// Its own key family, not `runs.list(...)` - see `queryKeys.runs.lastCollectionRuns`.
		queryKey: queryKeys.runs.lastCollectionRun(collectionId ?? ""),
		queryFn: () =>
			apiService.listRuns({
				collectionId: collectionId!,
				limit: 1,
			}),
		enabled: !!collectionId,
	});
}

/**
 * How the run being viewed says which request it was - the two ways a baseline
 * can be looked up, in the order they are tried.
 *
 * A saved request has an id, and the engine filters on it exactly. A run of an
 * unsaved request has none (its `requestId` is null), and the only identity it
 * left behind is the url and method on its row summary - so those are matched
 * instead, over a bounded page of pinned runs.
 */
export interface BaselineTarget {
	requestId?: string | null;
	url?: string | null;
	method?: string | null;
}

/**
 * How many pinned runs the url/method fallback looks at. `q` is a substring
 * match over the stored snapshot text, so it over-matches by design (a url is
 * a substring of longer urls, and of any body quoting it); the exact match
 * happens here, over a page small enough that an unsaved request with a heavily
 * pinned history costs one bounded request rather than a walk of the archive.
 */
const BASELINE_SCAN_LIMIT = 20;

function baselineCacheKey(target: BaselineTarget): string | null {
	if (target.requestId) return target.requestId;
	if (target.url && target.method) return `${target.method} ${target.url}`;
	return null;
}

/**
 * The run pinned as baseline for the same request as @p target, or `null` when
 * nothing is pinned.
 *
 * `GET /runs?baseline=true` is ordered newest-first, so "the baseline" is the
 * first row - the engine allows several pins (one per request is the expected
 * use) and deliberately holds no opinion about which applies where, so choosing
 * is the client's job and this is the one place the renderer does it. The MCP
 * `compare_runs` tool resolves it the same way, against the same endpoint.
 *
 * `null` and "still loading" are different answers and stay different: the
 * caller renders nothing until this settles, rather than flashing a
 * "no baseline" state at every run it opens.
 */
export function useBaselineRunQuery(target: BaselineTarget | null) {
	const key = target ? baselineCacheKey(target) : null;

	return useQuery<Run | null>({
		// Its own key family, not `runs.list(...)` - see `queryKeys.runs.baseline`.
		queryKey: queryKeys.runs.baseline(key ?? ""),
		queryFn: async () => {
			if (target?.requestId) {
				const page = await apiService.listRuns({
					baseline: true,
					requestId: target.requestId,
					limit: 1,
				});
				return page.data[0] ?? null;
			}
			// The unsaved-request fallback. `q` narrows server-side; the row's
			// own summary decides, so a url that merely *contains* this one is
			// not mistaken for it.
			const page = await apiService.listRuns({
				baseline: true,
				q: target!.url!,
				limit: BASELINE_SCAN_LIMIT,
			});
			const method = target!.method!.toUpperCase();
			return (
				page.data.find(
					(run) =>
						run.summary?.url === target!.url &&
						(run.summary?.method ?? "GET").toUpperCase() === method
				) ?? null
			);
		},
		enabled: !!key,
		staleTime: QUERY_CACHE.RUNS_STALE_TIME_MS,
	});
}

// ============ Run Mutations ============

/**
 * Start a collection run.
 *
 * The mutation ends where the engine's answer does - at `202 {runId}`. It does
 * **not** attach to the live stream or open a tab: the run is now the engine's,
 * and what the app does with it is the caller's decision (`RunCollectionDialog`
 * opens the tab and starts monitoring). Keeping those out means a caller that
 * only wants the run - a future keyboard shortcut, a re-run button - does not
 * inherit a tab it did not ask for.
 *
 * Every rejection is a `400` raised before a run row exists (an empty
 * collection, a step that will not compose, a plan over `maxScenarioSteps`), so
 * a failed mutation leaves nothing behind to clean up. The list is invalidated
 * only on success for that reason.
 */
export function useStartScenarioRunMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: StartScenarioRunRequest) => apiService.startScenarioRun(payload),
		onSuccess: () => {
			// The new run belongs at the head of History, and the list's 5s poll
			// is off once the user has paged it.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
			// ...and it is now the collection's last run. That family is its own
			// (see `queryKeys.runs.lastCollectionRuns`), so `lists()` does not
			// reach it and an open context bar would keep showing the run before
			// this one.
			void queryClient.invalidateQueries({
				queryKey: queryKeys.runs.lastCollectionRuns(),
			});
		},
	});
}

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
			// The Recent sends caches are keyed by request, and a deleted run
			// gives no way back to one - so the whole family is invalidated
			// rather than patched. Refetching a five-row list is cheaper than
			// carrying a run-to-request map just to patch it.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.recentDesigns() });
			// Same for the per-collection Last run caches: deleting a collection's
			// most recent run changes what that section says, and the deleted id
			// gives no way back to the collection.
			void queryClient.invalidateQueries({
				queryKey: queryKeys.runs.lastCollectionRuns(),
			});
			// And the per-request baseline caches, for the third time and the
			// same reason: the deleted run may have been the pin, and its id
			// gives no way back to the request it was pinned for.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.baselines() });
		},
	});
}

/**
 * Pin or unpin a run as its request's baseline.
 *
 * The engine answers with the updated row, so the loaded list pages are patched
 * from it rather than refetched - the same in-place patch `useDeleteRunMutation`
 * does, and for the same reason: the sidebar polls only its first page, so a
 * refetch would leave a pin invisible on any page the user had scrolled to.
 *
 * The baseline family is invalidated rather than patched: the pin *moves*, so
 * the previous holder's cached answer is now wrong and there is no way back
 * from a run id to the request whose baseline it was (a run of an unsaved
 * request has no `requestId` at all).
 */
export function useSetRunBaselineMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ runId, baseline }: { runId: string; baseline: boolean }) =>
			apiService.setRunBaseline(runId, baseline),
		onSuccess: (updated) => {
			queryClient.setQueriesData<InfiniteData<RunListResponse>>(
				{ queryKey: queryKeys.runs.lists() },
				(old) => {
					// A cache under this prefix that is not paged is left alone
					// rather than thrown on - see useDeleteRunMutation.
					if (!old || !Array.isArray(old.pages)) return old;
					return {
						...old,
						pages: old.pages.map((page) => {
							if (!page.data.some((r) => r.id === updated.id)) return page;
							return {
								...page,
								data: page.data.map((r) =>
									r.id === updated.id ? { ...r, baseline: updated.baseline } : r
								),
							};
						}),
					};
				}
			);
			// The run detail carries the flag too (GET /runs/:id emits it).
			queryClient.setQueryData<Run>(queryKeys.runs.detail(updated.id), (old) =>
				old ? { ...old, baseline: updated.baseline } : old
			);
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.baselines() });
		},
	});
}

/**
 * Invalidate every runs list (trigger refetch) - the polled infinite list, the
 * all-runs Settings query, the per-request Recent sends and per-collection
 * Last run lists, and the per-request baseline lookups, which are their own
 * families and would otherwise survive a cleared history.
 */
export function useInvalidateRuns() {
	const queryClient = useQueryClient();

	return () => {
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.allRuns() });
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.recentDesigns() });
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastCollectionRuns() });
		queryClient.invalidateQueries({ queryKey: queryKeys.runs.baselines() });
	};
}
