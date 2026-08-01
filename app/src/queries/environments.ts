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
import { useSessionStore } from "@/stores/session-store";
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
 * The mutation key the active-environment switch runs under, so the restore
 * hook can tell "the engine has not been told yet" from "the engine disagrees"
 * and stand back while a switch is in flight.
 */
export const setActiveEnvironmentMutationKey = ["environments", "set-active"] as const;

/**
 * Switch the active environment, or clear it (`null`).
 *
 * One PUT does the whole switch: the engine deactivates the previous
 * environment in the same transaction, so there is no second request to write
 * and no window where two environments are active. That is also why this
 * invalidates the list instead of patching the response into it - the response
 * describes the environment that was activated, while the row that was
 * *de*activated changed server-side without appearing in any response body.
 * Patching only the response would leave the old one reading active forever.
 *
 * The session store is written optimistically because the switcher, the
 * resolver and every composed payload read it, and rolled back if the engine
 * refuses - a selection the engine did not accept must not survive in the UI,
 * or the next launch would silently disagree with the one before it.
 */
export function useSetActiveEnvironmentMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationKey: setActiveEnvironmentMutationKey,
		mutationFn: async ({
			id,
			previousId,
		}: {
			id: string | null;
			previousId: string | null;
		}) => {
			// Clearing is spelled as deactivating the environment that holds the
			// flag: there is no "no environment" row to write true to.
			const target = id ?? previousId;
			if (!target) return;
			await apiService.updateEnvironment({ id: target, isActive: id !== null });
		},
		onMutate: ({ id }) => {
			const rolledBackTo = useSessionStore.getState().activeEnvironmentId;
			useSessionStore.getState().setActiveEnvironmentId(id);
			return { rolledBackTo };
		},
		onError: (_error, _variables, context) => {
			if (context) {
				useSessionStore.getState().setActiveEnvironmentId(context.rolledBackTo);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.environments.list() });
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
