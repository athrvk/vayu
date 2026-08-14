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
 * the engine back. The capture list is fetched once per inbox and appended to
 * by the SSE stream (`useInboxLive`); it is deliberately not polled, since the
 * stream is the thing that knows a capture arrived.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { TIMING } from "@/config/timing";
import type { InboxCannedResponse, StartInboxRequest } from "@/types";
import { queryKeys } from "./keys";

/**
 * Every inbox this engine has started, running or stopped.
 *
 * Polled - unlike the captures below, which the stream owns. The list changes
 * when *somebody* starts or stops an inbox, and this window is not the only one
 * who can: the MCP tools and a bare curl reach the same routes. The Services
 * drawer and the Dock's running-services indicator both promise to show a
 * running listener wherever it came from, which a list only this app's own
 * mutations refreshed could not do.
 */
export function useInboxesQuery() {
	return useQuery({
		queryKey: queryKeys.inbox.list(),
		queryFn: () => apiService.listInboxes(),
		refetchInterval: TIMING.SERVICES_POLL_INTERVAL_MS,
	});
}

/**
 * One inbox's recorded requests, newest first.
 *
 * Disabled without an inbox id so the surface can call it unconditionally
 * before anything is started.
 */
export function useInboxCapturesQuery(inboxId: string | null) {
	return useQuery({
		queryKey: queryKeys.inbox.captures(inboxId ?? ""),
		queryFn: () => apiService.listInboxCaptures(inboxId as string),
		enabled: inboxId !== null,
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
			// Refetch rather than write an empty page in: a clear that raced an
			// arriving webhook would otherwise leave the cache claiming a list
			// the engine has already refilled.
			void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.captures(inboxId) });
		},
	});
}
