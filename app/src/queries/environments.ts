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
import { invalidateCompositions } from "./compose-invalidation";
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
			invalidateCompositions(queryClient);
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
 * Counts the switches started, so a failing one can tell whether a newer
 * switch has taken over the store since (#3355). Module-level because the
 * mutation is a hook: two components mounting it share one engine and one
 * store, so they share this state.
 */
let latestSwitchSeq = 0;

/** Switches between `onMutate` and `onSettled`, successful or not. */
let switchesInFlight = 0;

/**
 * The active environment the engine is known to hold: what the store showed
 * when no switch was in flight, then the id of each PUT that landed. The store
 * itself cannot answer this while switches are pending, because it holds the
 * newest optimistic choice and not the last accepted one.
 */
let settledActiveId: string | null = null;

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
 * or the next launch would silently disagree with the one before it. The
 * rollback target is `settledActiveId`, never the store's value at the time the
 * switch started: with A active, a switch to B then C that both fail would
 * otherwise restore B, which the engine refused. A refusal rolls back only
 * while it is still the latest switch: a newer one has already replaced the
 * optimistic value and is about to hold or restore on its own account. The
 * `scope` makes the PUTs run one at a time in the order issued, so the engine
 * ends holding the last switch that landed, and a clear deactivates
 * `settledActiveId` - the row the engine really holds - rather than an
 * optimistic choice it may have refused. The optimistic write in `onMutate` is
 * not queued, so the switcher still answers at once (#3355).
 */
export function useSetActiveEnvironmentMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationKey: setActiveEnvironmentMutationKey,
		scope: { id: setActiveEnvironmentMutationKey.join(":") },
		mutationFn: async ({ id }: { id: string | null }) => {
			// Clearing is spelled as deactivating the environment that holds the
			// flag: there is no "no environment" row to write true to.
			const target = id ?? settledActiveId;
			if (target) await apiService.updateEnvironment({ id: target, isActive: id !== null });
			settledActiveId = id;
		},
		onMutate: ({ id }) => {
			if (switchesInFlight === 0) {
				settledActiveId = useSessionStore.getState().activeEnvironmentId;
			}
			switchesInFlight++;
			useSessionStore.getState().setActiveEnvironmentId(id);
			return { seq: ++latestSwitchSeq };
		},
		onError: (_error, _variables, context) => {
			if (!context || context.seq !== latestSwitchSeq) return;
			useSessionStore.getState().setActiveEnvironmentId(settledActiveId);
		},
		onSettled: () => {
			switchesInFlight--;
			queryClient.invalidateQueries({ queryKey: queryKeys.environments.list() });
		},
	});
}

/**
 * Delete an environment. A soft delete (#2970): the engine moves it to the
 * Trash and clears its active flag, so `trash.all` is invalidated for an open
 * Trash view to list it - the same cross-boundary invalidation the collection
 * and request deletes make.
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
			queryClient.invalidateQueries({ queryKey: queryKeys.trash.all });
			/*
			 * Deleting the active environment has to clear the session id, and it
			 * belongs here rather than in either delete flow: the switcher only
			 * *displays* "No Environment" through a defensive `find()`, while the
			 * id itself keeps riding on every /compose and /runs payload and
			 * persists to localStorage across restarts. Both delete call sites
			 * (the editor's danger zone and the sidebar tree) go through this
			 * mutation, so one cleanup covers both.
			 */
			if (useSessionStore.getState().activeEnvironmentId === deletedId) {
				useSessionStore.getState().setActiveEnvironmentId(null);
			}
		},
	});
}
