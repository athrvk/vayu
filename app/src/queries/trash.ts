/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Trash Queries
 *
 * The read side of the engine's soft delete (issue #988): deleting a collection
 * or a request stamps the row and keeps it, and these are how the app sees what
 * it stamped.
 *
 * **Both mutations invalidate across the live/deleted boundary, in opposite
 * directions.** A restore puts rows back into the tree, so it invalidates the
 * collection and request caches as well as this list; a purge only destroys
 * rows that were already filtered out of every live read, so it invalidates
 * nothing but this list. The delete mutations in `collections.ts` are the third
 * side of the same triangle - they invalidate `trash.all`, because a delete is
 * what *adds* an entry here.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import type { ListTrashResponse } from "@/types";

/**
 * Every deleted root, newest first.
 *
 * No `staleTime`: the list changes only through the three mutations that
 * invalidate it and through the startup retention purge, so the default is
 * already the cheapest correct answer - and a stale window here would show a
 * restored item still sitting in the trash.
 */
export function useTrashQuery() {
	return useQuery<ListTrashResponse>({
		queryKey: queryKeys.trash.list(),
		queryFn: () => apiService.listTrash(),
	});
}

/**
 * Put one deleted root back.
 *
 * Coarse invalidation of `collections.all` and `requests.all`, matching what
 * `useDeleteCollectionMutation` does for the same reason: which rows a restore
 * brought back is engine-side knowledge (the cohort is defined by a timestamp
 * the client never sees), so a client patching caches surgically would drift
 * from the engine's answer. `prefetch.allRequests` goes with them - it is the
 * warm-cache pass over every collection's requests, and a restored collection
 * is one it has never seen.
 */
export function useRestoreTrashMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.restoreTrashEntry(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.trash.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.prefetch.allRequests() });
		},
	});
}

/**
 * Destroy one deleted root for good.
 *
 * Only the trash list is invalidated. Every other cache stopped serving these
 * rows when they were stamped, so purging them changes nothing a live read can
 * see - invalidating the tree here would refetch it to produce the same answer.
 */
export function usePurgeTrashMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.purgeTrashEntry(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.trash.all });
		},
	});
}
