/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import type { OAuth2StepUpRequest, OAuth2TokenRequest } from "@/types";
import { queryKeys } from "./keys";

/**
 * Poll the engine's token cache status for a cache key. Disabled without a key (config incomplete).
 * Refetches periodically so the status row reflects expiry without a manual refresh.
 */
export function useOAuth2TokenStatusQuery(cacheKey: string | null) {
	return useQuery({
		queryKey: queryKeys.oauth.token(cacheKey ?? ""),
		queryFn: () => apiService.getOAuth2TokenStatus(cacheKey as string),
		enabled: !!cacheKey,
		refetchInterval: 30_000,
		staleTime: 10_000,
	});
}

/** Acquire (or force-refresh) a token; invalidates the matching status query. */
export function useFetchOAuth2TokenMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: OAuth2TokenRequest) => apiService.fetchOAuth2Token(data),
		onSuccess: (token) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.oauth.token(token.cacheKey) });
		},
	});
}

/** Clear a cached token; invalidates the matching status query. */
export function useClearOAuth2TokenMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (cacheKey: string) => apiService.clearOAuth2Token(cacheKey),
		onSuccess: (_result, cacheKey) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.oauth.token(cacheKey) });
		},
	});
}

/**
 * Whether a response's `WWW-Authenticate` asks for more scope (#3766). The
 * engine only classifies, so the answer is a function of the input: it is
 * never stale and never polled. Disabled for a null input.
 */
export function useOAuth2StepUpQuery(input: OAuth2StepUpRequest | null) {
	return useQuery({
		queryKey: queryKeys.oauth.stepUp(input?.wwwAuthenticate ?? [], input?.scope ?? ""),
		queryFn: () => apiService.classifyOAuth2StepUp(input as OAuth2StepUpRequest),
		enabled: input !== null,
		staleTime: Infinity,
	});
}
