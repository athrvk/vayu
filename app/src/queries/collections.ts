/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collections Queries
 *
 * TanStack Query hooks for collections and requests CRUD operations.
 */

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { apiService } from "@/services/api";
import { ApiError } from "@/services";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
import { useResponseStore } from "@/stores/response-store";
import { useSaveStore } from "@/stores/save-store";
import { useDataFileStore } from "@/stores/data-file-store";
import { walkAncestors } from "@/modules/collections/tree-utils";
import type {
	Collection,
	Request,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	CreateRequestRequest,
	UpdateRequestRequest,
	ReorderRequest,
} from "@/types";
import { compareTreeOrder } from "@/types";

// ============ Collection Queries ============

/**
 * Fetch all collections
 */
export function useCollectionsQuery() {
	return useQuery({
		queryKey: queryKeys.collections.list(),
		queryFn: () => apiService.listCollections(),
	});
}

/**
 * Prefetch all collections and their requests
 *
 * This hook fetches all collections and then prefetches requests for each.
 * Useful for app initialization to populate the cache.
 */
export function usePrefetchCollectionsAndRequests() {
	const queryClient = useQueryClient();
	const { data: collections = [] } = useCollectionsQuery();

	// Prefetch requests for all collections when collections are loaded
	useQuery({
		queryKey: queryKeys.prefetch.allRequests(),
		queryFn: async () => {
			// Prefetch requests for each collection in parallel
			await Promise.all(
				collections.map((collection) =>
					queryClient.prefetchQuery({
						queryKey: queryKeys.requests.listByCollection(collection.id),
						queryFn: () => apiService.listRequests({ collectionId: collection.id }),
						staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
					})
				)
			);
			return true;
		},
		enabled: collections.length > 0,
		staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS, // Re-prefetch once stale
		refetchOnWindowFocus: false,
	});

	return { collections };
}

/**
 * Fetch requests for a specific collection
 */
export function useRequestsQuery(collectionId: string | null) {
	return useQuery({
		queryKey: queryKeys.requests.listByCollection(collectionId ?? ""),
		queryFn: () => apiService.listRequests({ collectionId: collectionId! }),
		enabled: !!collectionId,
	});
}

/**
 * Fetch requests for multiple collections (e.g., all expanded ones)
 * Uses TanStack Query's useQueries for parallel fetching.
 *
 * The returned `requestsByCollection` is **referentially stable** while the
 * underlying query results are unchanged, and callers depend on that: an effect
 * that lists it in its dependency array must fire when the requests change and
 * not merely because the tree re-rendered. This used to build the map inline on
 * every call, which is what pinned a collection open in the sidebar - the
 * reveal effect in `CollectionTree` re-ran after every render and undid the
 * chevron click that had just collapsed it.
 */
export function useMultipleCollectionRequests(collectionIds: string[]) {
	// Callers build this array inline from the collections query, so it is a new
	// array on every render. Pin it to its contents: it is what `combine` closes
	// over, and `combine` has to keep a stable identity (see below).
	const idsKey = collectionIds.join(",");
	// eslint-disable-next-line react-hooks/exhaustive-deps -- `idsKey` is the contents of `collectionIds`
	const stableCollectionIds = useMemo(() => collectionIds, [idsKey]);

	/*
	 * `combine` is memoised by TanStack: it re-runs only when the query results
	 * or the query hashes change - *and* only if the function itself is the same
	 * reference as last render (`QueriesObserver` compares `combine` by
	 * identity). An inline arrow would therefore rebuild the map every render
	 * and defeat the whole point, so this is a `useCallback`.
	 */
	const combine = useCallback(
		(results: Array<UseQueryResult<Request[]>>) => {
			// Map of collectionId -> requests, sorted by order then createdAt.
			const requestsByCollection = new Map<string, Request[]>();
			results.forEach((query, index) => {
				const requests = query.data ?? [];
				requestsByCollection.set(
					stableCollectionIds[index],
					[...requests].sort(compareTreeOrder)
				);
			});
			return {
				requestsByCollection,
				isLoading: results.some((q) => q.isLoading),
			};
		},
		[stableCollectionIds]
	);

	// Create a query for each collection
	return useQueries({
		queries: stableCollectionIds.map((collectionId) => ({
			queryKey: queryKeys.requests.listByCollection(collectionId),
			queryFn: () => apiService.listRequests({ collectionId: collectionId }),
		})),
		combine,
	});
}

/**
 * The error thrown when the lookup completes and the request is genuinely gone -
 * as opposed to a transport failure, which throws whatever the fetch rejected
 * with. Callers that must tell a real deletion from an unreachable engine
 * (`DesignRunView`, which replays an orphan run's recorded headers only for a
 * true deletion) discriminate with `isRequestNotFound`, not by matching the
 * message string - so the wording below can change without silently reopening
 * that bug. It matters because `.catch(() => [])` on each per-collection list
 * fetch means one swallowed transient failure can otherwise masquerade as "not
 * found" on an otherwise healthy engine.
 */
export class RequestNotFoundError extends Error {
	readonly requestId: string;
	constructor(requestId: string) {
		super(`Request ${requestId} no longer exists`);
		this.name = "RequestNotFoundError";
		this.requestId = requestId;
	}
}

/** True only for a genuine deletion, never for a transport failure. */
export function isRequestNotFound(error: unknown): error is RequestNotFoundError {
	return error instanceof RequestNotFoundError;
}

/**
 * Fetch a single request by ID.
 *
 * One round trip: `GET /requests/:id`. The engine reads it straight out of the
 * DB, so this no longer fetches every collection's list and scans them for the
 * id - the N+1 fan-out that used to run on every cold start, once per restored
 * request tab.
 *
 * That scan was also a race it usually lost on launch: tabs are persisted, so
 * this runs immediately for each restored tab while the lists are still two
 * round trips from being filled, and `staleTime: Infinity` parked the "not
 * found" it threw so it never recovered once the lists *did* arrive. A point
 * lookup has no such window - a 404 is authoritative the instant it returns.
 *
 * The 404-vs-everything-else split is load-bearing, not cosmetic. `getRequest`
 * throws `ApiError` on any non-2xx; only a real 404 becomes
 * `RequestNotFoundError` (a genuine deletion), and every other failure - a 5xx,
 * an unreachable engine - is rethrown untouched. That is what lets callers like
 * `DesignRunView` tell "the request was deleted" from "the engine hiccuped",
 * which the old `.catch(() => [])` scan could not: one swallowed list failure
 * looked identical to "not in any list".
 *
 * Already-cached ids (a request just created or updated writes its own detail
 * cache) are served without a network call, because `staleTime: Infinity` keeps
 * the cached value fresh.
 */
/**
 * The options behind `useRequestQuery`, exported so a caller that needs many
 * requests at once can feed them to `useQueries` without restating the retry
 * and 404 rules. The tab strip does exactly that: it has to know what every
 * open tab is called before it can decide how many fit, and a hook per tab
 * inside a map would be a variable number of hooks.
 */
export function requestDetailOptions(requestId: string | null) {
	return {
		queryKey: queryKeys.requests.detail(requestId ?? ""),
		queryFn: async () => {
			try {
				return await apiService.getRequest(requestId!);
			} catch (error) {
				// A definitive deletion, distinct from a transport failure.
				if (error instanceof ApiError && error.statusCode === 404) {
					throw new RequestNotFoundError(requestId!);
				}
				throw error;
			}
		},
		enabled: !!requestId,
		// Never retry a real deletion - a 404 is final. Only a transport failure
		// is worth a retry, and only a bounded number of times.
		retry: (count: number, error: unknown) =>
			!isRequestNotFound(error) && count < QUERY_CACHE.REQUEST_LOOKUP_RETRY,
		retryDelay: QUERY_CACHE.REQUEST_LOOKUP_RETRY_DELAY_MS,
		staleTime: Infinity,
	};
}

export function useRequestQuery(requestId: string | null) {
	return useQuery(requestDetailOptions(requestId));
}

/**
 * Return the ancestor chain for a collection, root-first (inclusive of the collection itself).
 * Used for hierarchical auth/script composition before execution.
 */
export function useCollectionAncestors(collectionId: string | null | undefined): Collection[] {
	const { data: collections = [] } = useCollectionsQuery();

	// `walkAncestors` carries the cycle guard this loop was missing: it runs
	// inside a `useMemo`, so a `parentId` cycle hangs the renderer rather than
	// producing a wrong chain (see modules/collections/tree-utils).
	return useMemo(
		() => (collectionId ? walkAncestors(collectionId, collections) : []),
		[collections, collectionId]
	);
}

// ============ Collection Mutations ============

/**
 * Create a new collection
 */
export function useCreateCollectionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateCollectionRequest) => apiService.createCollection(data),
		onSuccess: (newCollection) => {
			queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) => {
				const next = old ? [...old, newCollection] : [newCollection];
				return next.sort(compareTreeOrder);
			});
			// The warm-cache pass is a query like any other: it succeeded once at
			// startup and would stay fresh forever, so a collection created
			// mid-session never got one. Invalidating re-runs it over the new set.
			queryClient.invalidateQueries({ queryKey: queryKeys.prefetch.allRequests() });
		},
	});
}

/**
 * Update an existing collection
 */
export function useUpdateCollectionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateCollectionRequest) => apiService.updateCollection(data),
		onSuccess: (updatedCollection) => {
			queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) => {
				const next =
					old?.map((c) => (c.id === updatedCollection.id ? updatedCollection : c)) ?? [];
				return next.sort(compareTreeOrder);
			});
		},
	});
}

/**
 * Delete a collection
 */
export function useDeleteCollectionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.deleteCollection(id),
		onSuccess: (_, deletedId) => {
			// Remove from cache
			queryClient.setQueryData<Collection[]>(
				queryKeys.collections.list(),
				(old) => old?.filter((c) => c.id !== deletedId) ?? []
			);
			/*
			 * The engine cascade-deletes every descendant collection and their
			 * requests, and which rows those are is engine-side knowledge - the
			 * client must not re-derive the tree to patch caches surgically, or
			 * the two definitions of "descendant" drift.
			 *
			 * So both families are invalidated wholesale. `requests.all` rather
			 * than this collection's list: descendants had their own list caches,
			 * and `requests.detail` entries carry `staleTime: Infinity`, so
			 * without this a deleted request stays fresh forever and keeps feeding
			 * restored tabs. `collections.all` covers the descendants left behind
			 * by the single-id filter above, which the ancestor walk and the
			 * resolver would otherwise still see.
			 */
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
			/*
			 * The remembered data-file path goes with the collection (issue #599)
			 * - a path kept for a collection that no longer exists is a filesystem
			 * location persisted for nothing.
			 *
			 * The deleted id only, for the same reason the caches above are
			 * invalidated wholesale rather than patched: which rows the engine's
			 * cascade took is engine-side knowledge, and re-deriving the subtree
			 * here would be the second definition of "descendant" that comment
			 * exists to prevent. A descendant's entry is left behind and is inert
			 * - it is keyed by an id nothing renders, so nothing reads it.
			 */
			useDataFileStore.getState().clearDataFile(deletedId);
		},
	});
}

// ============ Request Mutations ============

/**
 * Create a new request
 */
export function useCreateRequestMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateRequestRequest) => apiService.createRequest(data),
		onSuccess: (newRequest) => {
			// Add to collection's requests cache
			queryClient.setQueryData<Request[]>(
				queryKeys.requests.listByCollection(newRequest.collectionId),
				(old) => (old ? [...old, newRequest] : [newRequest])
			);
			// Also set the detail cache so useRequestQuery can find it immediately
			queryClient.setQueryData(queryKeys.requests.detail(newRequest.id), newRequest);
		},
	});
}

/**
 * Update an existing request
 */
export function useUpdateRequestMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateRequestRequest) => apiService.updateRequest(data),
		onSuccess: (updatedRequest) => {
			/*
			 * Only the lists that can have changed. This used to invalidate every
			 * collection's list on any single-request update, so a rename refetched
			 * the whole tree - and the sibling PUTs a reorder issues would storm the
			 * engine once per row.
			 *
			 * A cross-collection move touches two lists. The response carries only
			 * the *new* collectionId, so the source is read from the detail cache,
			 * which still holds the pre-update row until the write below - the one
			 * place the old owner is knowable. An uncached detail (nothing had the
			 * request open) leaves the source list to its normal staleness rather
			 * than reinstating the fan-out.
			 */
			const previous = queryClient.getQueryData<Request>(
				queryKeys.requests.detail(updatedRequest.id)
			);
			const affected = new Set([updatedRequest.collectionId]);
			if (previous?.collectionId) affected.add(previous.collectionId);
			for (const collectionId of affected) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.requests.listByCollection(collectionId),
				});
			}
			// Update detail cache
			queryClient.setQueryData(queryKeys.requests.detail(updatedRequest.id), updatedRequest);
		},
	});
}

// ============ Reorder ============

/**
 * Every cache key a plan can touch, worked out before anything is written.
 *
 * A request move that states no `collectionId` stays where it is, but the plan
 * does not say where that is - so the owner is read out of the list caches the
 * tree is already showing. An uncached one simply contributes no key: nothing
 * on screen is displaying it, so nothing on screen can go stale.
 */
function affectedKeys(queryClient: ReturnType<typeof useQueryClient>, plan: ReorderRequest) {
	let touchesCollections = false;
	const requestScopes = new Set<string>();
	const movedRequestIds: string[] = [];

	const ownerOf = (requestId: string): string | undefined => {
		for (const [key, rows] of queryClient.getQueriesData<Request[]>({
			queryKey: queryKeys.requests.lists(),
		})) {
			void key;
			const found = rows?.find((row) => row.id === requestId);
			if (found) return found.collectionId;
		}
		return undefined;
	};

	for (const scope of plan.normalize) {
		if (scope.type === "collection") touchesCollections = true;
		else requestScopes.add(scope.collectionId);
	}
	for (const move of plan.moves) {
		if (move.type === "collection") {
			touchesCollections = true;
			continue;
		}
		movedRequestIds.push(move.id);
		const current = ownerOf(move.id);
		if (current) requestScopes.add(current);
		if (move.collectionId) requestScopes.add(move.collectionId);
	}
	return { touchesCollections, requestScopes, movedRequestIds };
}

/** The collections of one scope, renumbered dense in display order. */
function normalizeCollectionScope(list: Collection[], parentId: string | null): Collection[] {
	const positions = new Map(
		list
			.filter((c) => (c.parentId ?? null) === parentId)
			.sort(compareTreeOrder)
			.map((c, index) => [c.id, index] as const)
	);
	return list.map((c) => {
		const order = positions.get(c.id);
		return order === undefined || order === c.order ? c : { ...c, order };
	});
}

/**
 * Draws the plan into the caches, exactly as the engine will apply it -
 * normalize each named scope, then position each move.
 *
 * Every write goes through `setQueryData` with a fresh array. The maps
 * `useMultipleCollectionRequests` builds are referentially compared by the
 * reveal effect (see the comment on that hook), so mutating a cached array in
 * place would move a row on screen without the tree ever noticing.
 */
function drawPlan(queryClient: ReturnType<typeof useQueryClient>, plan: ReorderRequest) {
	for (const scope of plan.normalize) {
		if (scope.type === "collection") {
			queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) =>
				old ? normalizeCollectionScope(old, scope.parentId) : old
			);
		} else {
			queryClient.setQueryData<Request[]>(
				queryKeys.requests.listByCollection(scope.collectionId),
				(old) => old?.map((r, index) => ({ ...r, order: index }))
			);
		}
	}

	for (const move of plan.moves) {
		if (move.type === "collection") {
			queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) =>
				old
					?.map((c) =>
						c.id === move.id
							? {
									...c,
									order: move.order,
									...("parentId" in move
										? { parentId: move.parentId ?? undefined }
										: {}),
								}
							: c
					)
					.sort(compareTreeOrder)
			);
			continue;
		}
		placeRequest(queryClient, move.id, move.order, move.collectionId);
	}
}

/**
 * Puts one request at `order`, moving it between list caches when `collectionId`
 * names a different owner. Shared by the optimistic draw and by the settle on
 * the engine's response, so a move cannot be applied one way going out and
 * another coming back.
 */
function placeRequest(
	queryClient: ReturnType<typeof useQueryClient>,
	requestId: string,
	order: number,
	collectionId: string | undefined
) {
	let moved: Request | undefined;
	for (const [key, rows] of queryClient.getQueriesData<Request[]>({
		queryKey: queryKeys.requests.lists(),
	})) {
		const found = rows?.find((row) => row.id === requestId);
		if (!found) continue;
		moved = found;
		if (collectionId && collectionId !== found.collectionId) {
			queryClient.setQueryData<Request[]>(key, (old) =>
				old?.filter((row) => row.id !== requestId)
			);
		}
		break;
	}

	const owner = collectionId ?? moved?.collectionId;
	if (!owner) return; // Nothing cached is showing it; nothing on screen to fix.
	const next: Request = { ...(moved as Request), id: requestId, collectionId: owner, order };
	queryClient.setQueryData<Request[]>(queryKeys.requests.listByCollection(owner), (old) => {
		if (!old) return old;
		const without = old.filter((row) => row.id !== requestId);
		return [...without, next].sort(compareTreeOrder);
	});
	// Only if something already held it: `staleTime: Infinity` means an entry
	// written here would never be refetched, and a half-built row from a list
	// entry is not the full request a restored tab reads.
	queryClient.setQueryData<Request>(queryKeys.requests.detail(requestId), (old) =>
		old ? { ...old, collectionId: owner, order } : old
	);
}

/**
 * Apply one atomic batch reorder - the write path behind a drop.
 *
 * One `POST /reorder` per drop, not one `PUT` per displaced sibling: the engine
 * validates the whole batch and writes it in a single transaction, so a drop
 * that displaces N rows cannot half-land, cannot race a concurrent create into
 * the middle of its range, and costs one round trip instead of N.
 *
 * The cache work is three passes over the same helpers:
 *
 *  - `onMutate` snapshots every key the plan can touch and draws the plan into
 *    the caches, so the row is where the user dropped it before the request
 *    leaves.
 *  - `onSuccess` re-applies the rows the engine actually wrote. They are
 *    normally what was drawn, but a normalization the client planned and the
 *    engine performed is authoritative here, so the tree settles on real
 *    positions rather than on a guess that happens to sort the same.
 *  - `onError` restores the snapshots wholesale and reports through `failSave`,
 *    the one channel every save failure in the app reaches the Dock and the
 *    toast through.
 *
 * `onSettled` then invalidates the affected keys once - not per row, which is
 * the invalidation storm the per-row path produced.
 */
export function useReorderMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (plan: ReorderRequest) => apiService.reorder(plan),
		onMutate: async (plan: ReorderRequest) => {
			const keys = affectedKeys(queryClient, plan);
			const listKeys = [...keys.requestScopes].map((id) =>
				queryKeys.requests.listByCollection(id)
			);
			const snapshotKeys = [
				...(keys.touchesCollections ? [queryKeys.collections.list()] : []),
				...listKeys,
				...keys.movedRequestIds.map((id) => queryKeys.requests.detail(id)),
			];

			// An in-flight refetch would otherwise land after the optimistic
			// draw and overwrite it with the pre-drop order.
			await Promise.all(
				snapshotKeys.map((queryKey) => queryClient.cancelQueries({ queryKey }))
			);
			const snapshots = snapshotKeys.map(
				(queryKey) => [queryKey, queryClient.getQueryData(queryKey)] as const
			);

			drawPlan(queryClient, plan);
			return { snapshots, keys };
		},
		onSuccess: (result) => {
			if (result.collections.length > 0) {
				const written = new Map(result.collections.map((c) => [c.id, c]));
				queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) =>
					old?.map((c) => written.get(c.id) ?? c).sort(compareTreeOrder)
				);
			}
			for (const request of result.requests) {
				placeRequest(queryClient, request.id, request.order, request.collectionId);
			}
		},
		onError: (error, _plan, context) => {
			for (const [queryKey, data] of context?.snapshots ?? []) {
				queryClient.setQueryData(queryKey, data);
			}
			useSaveStore
				.getState()
				.failSave(error instanceof Error ? error.message : "Failed to reorder");
		},
		onSettled: (_data, _error, _plan, context) => {
			if (context?.keys.touchesCollections) {
				queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
			}
			for (const collectionId of context?.keys.requestScopes ?? []) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.requests.listByCollection(collectionId),
				});
			}
		},
	});
}

/**
 * Delete a request
 */
export function useDeleteRequestMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => apiService.deleteRequest(id),
		onSuccess: (_, deletedId) => {
			// Invalidate all request lists since we don't know the collection
			queryClient.invalidateQueries({
				queryKey: queryKeys.requests.lists(),
			});
			// Remove the detail cache for this request
			queryClient.removeQueries({
				queryKey: queryKeys.requests.detail(deletedId),
			});
			// The response map is keyed by request id and nothing else evicts from
			// it, so a deleted request would otherwise hold its body (plus the raw
			// copy) for the rest of the session. Here rather than only at the tab
			// seam: the delete is what makes the response unreachable, whether or
			// not a tab was open on it.
			useResponseStore.getState().clearResponse(deletedId);
		},
	});
}
