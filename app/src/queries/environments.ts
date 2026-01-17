
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Environments Queries
 *
 * TanStack Query hooks for environment CRUD operations.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { Environment, CreateEnvironmentRequest, UpdateEnvironmentRequest } from "@/types";

// ============ Environment Queries ============

/**
 * Fetch all environments
 */
export function useEnvironmentsQuery() {
	return useQuery({
		queryKey: queryKeys.environments.list(),
		queryFn: () => apiService.listEnvironments(),
	});
}

/**
 * Fetch a single environment by ID
 */
export function useEnvironmentQuery(environmentId: string | null) {
	return useQuery({
		queryKey: queryKeys.environments.detail(environmentId ?? ""),
		queryFn: () => apiService.getEnvironment(environmentId!),
		enabled: !!environmentId,
	});
}

// ============ Environment Mutations ============

/**
 * Create a new environment
 */
export function useCreateEnvironmentMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateEnvironmentRequest) => apiService.createEnvironment(data),
		onSuccess: (newEnvironment) => {
			// Add to cache
			queryClient.setQueryData<Environment[]>(queryKeys.environments.list(), (old) =>
				old ? [...old, newEnvironment] : [newEnvironment]
			);
		},
	});
}

/**
 * Update an existing environment
 */
export function useUpdateEnvironmentMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateEnvironmentRequest) => apiService.updateEnvironment(data),
		onSuccess: (updatedEnvironment) => {
			// Update in list cache
			queryClient.setQueryData<Environment[]>(
				queryKeys.environments.list(),
				(old) =>
					old?.map((e) => (e.id === updatedEnvironment.id ? updatedEnvironment : e)) ?? []
			);
			// Update detail cache
			queryClient.setQueryData(
				queryKeys.environments.detail(updatedEnvironment.id),
				updatedEnvironment
			);
		},
	});
}

/**
 * Delete an environment
 */
export function useDeleteEnvironmentMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.deleteEnvironment(id),
		onSuccess: (_, deletedId) => {
			// Remove from cache
			queryClient.setQueryData<Environment[]>(
				queryKeys.environments.list(),
				(old) => old?.filter((e) => e.id !== deletedId) ?? []
			);
			// Remove detail cache
			queryClient.removeQueries({
				queryKey: queryKeys.environments.detail(deletedId),
			});
		},
	});
}
