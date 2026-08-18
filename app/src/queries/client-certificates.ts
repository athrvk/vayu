/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Client-certificate registry queries (issue #707)
 *
 * The engine maps host patterns to certificates and presents the matching one
 * on every outbound path - design sends, load runs, SSE streams, scripts and
 * the OAuth token fetch. These back the Settings card that manages the map.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import type { ClientCertificateInput } from "@/types";
import { queryKeys } from "./keys";

/** Every registered entry. Read by the Settings card; not polled. */
export function useClientCertificatesQuery() {
	return useQuery({
		queryKey: queryKeys.clientCertificates.all,
		queryFn: () => apiService.getClientCertificates(),
	});
}

export function useCreateClientCertificateMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: ClientCertificateInput) => apiService.createClientCertificate(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.clientCertificates.all });
		},
	});
}

export function useUpdateClientCertificateMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: Partial<ClientCertificateInput> }) =>
			apiService.updateClientCertificate(id, patch),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.clientCertificates.all });
		},
	});
}

export function useDeleteClientCertificateMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.deleteClientCertificate(id),
		onSuccess: () => {
			// Refetched rather than patched out of the cache: the engine refuses
			// a duplicate host+port pair, so the list is the authority on what a
			// new entry may claim and a hand-patched one could offer a target
			// that is still taken.
			void queryClient.invalidateQueries({ queryKey: queryKeys.clientCertificates.all });
		},
	});
}
