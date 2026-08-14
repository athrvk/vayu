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
 * The route table is *not* polled. It is a snapshot taken when the mock started
 * and it cannot change under a running mock - editing the collection means
 * restarting - so a poll would re-fetch a constant every few seconds.
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
