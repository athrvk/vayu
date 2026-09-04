/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Webhook Inbox Queries (issue #480)
 *
 * An inbox is a listener the engine holds for as long as its process lives, so
 * none of this is stored state the app could rebuild - every hook here reads
 * the engine back. The capture list is fetched a page at a time and appended to
 * by the SSE stream (`services/inbox-watch-service.ts`); it is deliberately not
 * polled, since the stream is the thing that knows a capture arrived.
 *
 * Those two writers, plus the load-more below, share one cache entry per inbox
 * and every write to it is the union in {@link mergeCaptures}. That is the rule
 * this file exists to keep in one place: a second copy of it is how two writers
 * come to disagree about one list.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { TIMING } from "@/config/timing";
import { INBOX_CAPTURES_PAGE_LIMIT } from "@/config/network";
import type {
	InboxCannedResponse,
	InboxCapture,
	InboxCapturesResponse,
	StartInboxRequest,
} from "@/types";
import { queryKeys } from "./keys";

/**
 * Fold @p incoming into the cached capture page, newest first, unique by id.
 *
 * One cache entry holds the whole accumulated view rather than a page each,
 * because three writers feed it and they do not arrive in order: the first
 * fetch, the load-more pages behind it, and the live stream prepending to the
 * front of all of them. Union-by-id is what makes their overlap harmless - the
 * fetch and the stream overlap by however many captures arrived between them,
 * and a duplicate row is one the user cannot tell from a second delivery of the
 * same webhook.
 *
 * It is also why a fetch merges *into* the cache instead of replacing it: a
 * capture the stream delivered while the GET was in flight used to be
 * overwritten when the GET resolved, so the first webhook of a session could
 * vanish from a list that had already shown it.
 *
 * The engine orders by descending id and ids are monotonic, so sorting by id
 * reproduces its order without trusting the arrival order of the writers.
 *
 * `hasMore` is the page's own answer *and* the accumulated one: a background
 * refetch of the first page reports "there is more" whenever the inbox holds
 * over one page, which says nothing about whether this list has already loaded
 * it. Both have to be true for there to be a next page worth asking for.
 */
export function mergeCaptures(
	cached: InboxCapturesResponse | undefined,
	incoming: InboxCapture[],
	page: { total: number; hasMore: boolean }
): InboxCapturesResponse {
	const byId = new Map<number, InboxCapture>();
	for (const capture of cached?.data ?? []) byId.set(capture.id, capture);
	for (const capture of incoming) {
		if (!byId.has(capture.id)) byId.set(capture.id, capture);
	}
	const data = [...byId.values()].sort((a, b) => b.id - a.id);
	// The engine's count cannot be below what this list is already holding -
	// it is a separate query, and the stream runs ahead of it.
	const total = Math.max(page.total, data.length);
	return {
		data,
		pagination: {
			total,
			limit: INBOX_CAPTURES_PAGE_LIMIT,
			offset: 0,
			returned: data.length,
			hasMore: page.hasMore && data.length < total,
		},
	};
}

/**
 * Prepend one streamed capture to the cached page.
 *
 * Idempotent on the capture id, and the only writer that raises `total`: the
 * stream is how this surface learns a capture exists at all, ahead of the count
 * the list query polls.
 */
export function mergeCapture(
	cached: InboxCapturesResponse | undefined,
	capture: InboxCapture
): InboxCapturesResponse {
	const existing = cached?.data ?? [];
	if (existing.some((c) => c.id === capture.id)) {
		return cached as InboxCapturesResponse;
	}
	return mergeCaptures(cached, [capture], {
		total: (cached?.pagination.total ?? existing.length) + 1,
		// A capture arriving at the front says nothing about the tail.
		hasMore: cached?.pagination.hasMore ?? false,
	});
}

/** An emptied capture list - what a successful clear leaves behind. */
function clearedCapturePage(): InboxCapturesResponse {
	return {
		data: [],
		pagination: {
			total: 0,
			limit: INBOX_CAPTURES_PAGE_LIMIT,
			offset: 0,
			returned: 0,
			hasMore: false,
		},
	};
}

/**
 * Every inbox this engine has started, running or stopped.
 *
 * Polled - unlike the captures below, which the stream owns. The list changes
 * when *somebody* starts or stops an inbox, and this window is not the only one
 * who can: the MCP tools and a bare curl reach the same routes. The Services
 * drawer and the Dock's running-services indicator both promise to show a
 * running listener wherever it came from, which a list only this app's own
 * mutations refreshed could not do.
 *
 * `enabled` is for the app-level watcher (#1400), which needs the list only
 * while some inbox may notify on a capture: a root observer polling for the
 * app's whole life with nobody reading the answer is what #1150 removed. Every
 * surface that shows the list omits it and observes unconditionally.
 */
export function useInboxesQuery(options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: queryKeys.inbox.list(),
		queryFn: () => apiService.listInboxes(),
		refetchInterval: TIMING.SERVICES_POLL_INTERVAL_MS,
		enabled: options.enabled ?? true,
	});
}

/**
 * One inbox's recorded requests, newest first.
 *
 * Disabled without an inbox id so the surface can call it unconditionally
 * before anything is started.
 *
 * The fetched page is merged into whatever the cache already holds - see
 * {@link mergeCaptures}. The cache is read *after* the request resolves, which
 * is the point: anything the live stream wrote while this was in flight is
 * still there to merge with.
 */
export function useInboxCapturesQuery(inboxId: string | null) {
	const queryClient = useQueryClient();
	const queryKey = queryKeys.inbox.captures(inboxId ?? "");
	return useQuery({
		queryKey,
		queryFn: async () => {
			const page = await apiService.listInboxCaptures(inboxId as string);
			return mergeCaptures(
				queryClient.getQueryData<InboxCapturesResponse>(queryKey),
				page.data,
				page.pagination
			);
		},
		enabled: inboxId !== null,
	});
}

/**
 * Fetch the page after the captures already on screen (issue #556).
 *
 * The offset is the accumulated length rather than a page counter, and that is
 * exact rather than approximate: the stream prepends every capture recorded
 * since the last fetch, so the rows this list holds are always the newest
 * `length` the engine has, and the next unseen one sits at that index.
 *
 * A mutation rather than `useInfiniteQuery`: the pages are not independently
 * refetchable slices here - the stream writes into the same list, so an
 * infinite query's per-page caches would each have to be reconciled with it.
 */
export function useLoadMoreInboxCapturesMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ inboxId, offset }: { inboxId: string; offset: number }) =>
			apiService.listInboxCaptures(inboxId, INBOX_CAPTURES_PAGE_LIMIT, offset),
		onSuccess: (page, { inboxId }) => {
			queryClient.setQueryData<InboxCapturesResponse>(
				queryKeys.inbox.captures(inboxId),
				(cached) => mergeCaptures(cached, page.data, page.pagination)
			);
		},
	});
}

export function useStartInboxMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: StartInboxRequest = {}) => apiService.startInbox(request),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list() });
		},
	});
}

export function useStopInboxMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (inboxId: string) => apiService.stopInbox(inboxId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list() });
		},
	});
}

/**
 * Delete an inbox and the captures it holds (issue #553).
 *
 * Unlike a stop, there is nothing left to read afterwards - so the captures
 * cache entry is dropped rather than invalidated. An invalidation would refetch
 * an id the engine now answers `404` for, leaving an error state describing a
 * list that no longer exists.
 */
export function useDeleteInboxMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (inboxId: string) => apiService.deleteInbox(inboxId),
		onSuccess: (_result, inboxId) => {
			queryClient.removeQueries({ queryKey: queryKeys.inbox.captures(inboxId) });
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list() });
		},
	});
}

export function useUpdateInboxResponseMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			inboxId,
			response,
		}: {
			inboxId: string;
			response: Partial<InboxCannedResponse>;
		}) => apiService.updateInboxResponse(inboxId, response),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list() });
		},
	});
}

export function useClearInboxCapturesMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (inboxId: string) => apiService.clearInboxCaptures(inboxId),
		onSuccess: (_result, inboxId) => {
			// Emptied first, then refetched. The write is not the refetch racing
			// an arriving webhook - the refetch settles that - it is what stops
			// the merge in `useInboxCapturesQuery` from unioning the refetched
			// page back onto the very captures this call destroyed.
			queryClient.setQueryData(queryKeys.inbox.captures(inboxId), clearedCapturePage());
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.captures(inboxId) });
		},
	});
}
