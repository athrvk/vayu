/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth 2.0 Mock Issuer Queries (issue #479)
 *
 * An issuer is a listener the engine holds until it is stopped or the process
 * ends, so - as with an inbox - none of this is stored state the app could
 * rebuild: every hook here reads the engine back.
 *
 * The list is polled (`TIMING.SERVICES_POLL_INTERVAL_MS`) because this window
 * is not the only client with the lifecycle: the MCP tools hand it to an agent
 * and the routes answer curl. A mutation invalidating the list covers what this
 * app did; the poll covers everything else.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { TIMING } from "@/config/timing";
import type { StartMockIssuerRequest, UpdateMockIssuerRequest } from "@/types";
import { queryKeys } from "./keys";

/** Every issuer this engine is running. A stopped one is gone, not listed. */
export function useMockIssuersQuery() {
	return useQuery({
		queryKey: queryKeys.mockIssuer.list(),
		queryFn: () => apiService.listMockIssuers(),
		refetchInterval: TIMING.SERVICES_POLL_INTERVAL_MS,
	});
}

export function useStartMockIssuerMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (request: StartMockIssuerRequest = {}) => apiService.startMockIssuer(request),
		// The start reply carries the URLs and the signing key but none of the
		// settings, so it cannot be written into the list cache as a row - the
		// list is refetched for the full record instead.
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.mockIssuer.list() });
		},
	});
}

export function useUpdateMockIssuerMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ issuerId, update }: { issuerId: string; update: UpdateMockIssuerRequest }) =>
			apiService.updateMockIssuer(issuerId, update),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.mockIssuer.list() });
		},
	});
}

export function useStopMockIssuerMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (issuerId: string) => apiService.stopMockIssuer(issuerId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.mockIssuer.list() });
		},
	});
}
