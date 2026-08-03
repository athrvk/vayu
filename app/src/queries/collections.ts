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
import type {
	Collection,
	Request,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	CreateRequestRequest,
	UpdateRequestRequest,
} from "@/types";
import { compareCollectionOrder } from "@/types";

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

/** Requests within a collection are ordered by `order`, then by creation time. */
function compareRequestOrder(a: Request, b: Request): number {
	const orderDiff = (a.order ?? 0) - (b.order ?? 0);
	if (orderDiff !== 0) return orderDiff;
	const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
	const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
	return aTime - bTime;
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
					[...requests].sort(compareRequestOrder)
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

	return useMemo(() => {
		if (!collectionId) return [];
		const chain: Collection[] = [];
		let currentId: string | undefined = collectionId;
		while (currentId) {
			const col = collections.find((c) => c.id === currentId);
			if (!col) break;
			chain.unshift(col); // root first
			currentId = col.parentId;
		}
		return chain;
	}, [collections, collectionId]);
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
				return next.sort(compareCollectionOrder);
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
				return next.sort(compareCollectionOrder);
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
			// Update in cache - need to find which collection it belongs to
			// Invalidate all request lists to be safe
			queryClient.invalidateQueries({
				queryKey: queryKeys.requests.lists(),
			});
			// Update detail cache
			queryClient.setQueryData(queryKeys.requests.detail(updatedRequest.id), updatedRequest);
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
