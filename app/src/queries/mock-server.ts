/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection Mock Server Queries (issue #481 phase 2)
 *
 * A mock is a listener the engine holds until it is stopped or the process
 * ends, so - as with an inbox or an issuer - none of this is stored state the
 * app could rebuild: every hook here reads the engine back.
 *
 * The list is polled (`TIMING.SERVICES_POLL_INTERVAL_MS`) because this window
 * is not the only client with the lifecycle: the routes answer curl, and the
 * Services drawer and the collection header both promise to show a running mock
 * wherever it was started from.
 *
 * The route table's *shape* is not re-fetched on mount - it is a snapshot
 * taken when the mock started and cannot change under a running mock, editing
 * the collection means restarting. Each route's `hits`, though, changes live
 * as traffic arrives (the engine's own docs for `GET /mock/:id/routes` say
 * so), so the query still polls, at `TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS`
 * like the activity log - `staleTime: Infinity` only means mounting a second
 * reader of the same query does not force a redundant fetch, not that the
 * interval stops firing.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { TIMING } from "@/config/timing";
import type { StartMockServerRequest } from "@/types";
import { queryKeys } from "./keys";

/** Every mock this engine is running. A stopped one is gone, not listed. */
export function useMockServersQuery() {
	return useQuery({
		queryKey: queryKeys.mockServer.list(),
		queryFn: () => apiService.listMockServers(),
		refetchInterval: TIMING.SERVICES_POLL_INTERVAL_MS,
	});
}

/**
 * One mock's route table.
 *
 * Disabled without a mock id so a surface can call it unconditionally before
 * anything is started.
 */
export function useMockServerRoutesQuery(mockId: string | null) {
	return useQuery({
		queryKey: queryKeys.mockServer.routes(mockId ?? ""),
		queryFn: () => apiService.listMockServerRoutes(mockId as string),
		enabled: mockId !== null,
		staleTime: Infinity,
		refetchInterval: TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS,
	});
}

/**
 * One mock's activity log - what it has served, newest first. Polled like
 * the route table: unlike the route table's shape, this changes on its own as
 * traffic arrives, with nothing in this window driving it.
 */
export function useMockActivityQuery(mockId: string | null) {
	return useQuery({
		queryKey: queryKeys.mockServer.activity(mockId ?? ""),
		queryFn: () => apiService.listMockServerActivity(mockId as string),
		enabled: mockId !== null,
		refetchInterval: TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS,
	});
}

export function useStartMockServerMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: StartMockServerRequest) => apiService.startMockServer(request),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.mockServer.list() });
		},
	});
}

export function useStopMockServerMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (mockId: string) => apiService.stopMockServer(mockId),
		onSuccess: (_result, mockId) => {
			// Nothing is left to read once a mock is stopped - its record goes
			// with its listener - so the table cache is dropped rather than
			// invalidated, which would refetch an id the engine now 404s.
			queryClient.removeQueries({ queryKey: queryKeys.mockServer.routes(mockId) });
			void queryClient.invalidateQueries({ queryKey: queryKeys.mockServer.list() });
		},
	});
}
