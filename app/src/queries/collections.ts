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
import { useMemo } from "react";
import { apiService } from "@/services/api";
import { ApiError } from "@/services";
import { queryKeys } from "./keys";
import { QUERY_CACHE } from "@/config/cache";
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
		queryKey: ["prefetch", "all-requests"],
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
 * Uses TanStack Query's useQueries for parallel fetching
 */
export function useMultipleCollectionRequests(collectionIds: string[]) {
	// Create a query for each collection
	const queries = useQueries({
		queries: collectionIds.map((collectionId) => ({
			queryKey: queryKeys.requests.listByCollection(collectionId),
			queryFn: () => apiService.listRequests({ collectionId: collectionId }),
		})),
	});

	// Build a map of collectionId -> requests, sorted by order then createdAt
	const requestsByCollection = new Map<string, Request[]>();
	queries.forEach((query, index) => {
		const collectionId = collectionIds[index];
		const requests = query.data ?? [];
		const sortedRequests = [...requests].sort((a, b) => {
			const orderDiff = (a.order ?? 0) - (b.order ?? 0);
			if (orderDiff !== 0) return orderDiff;
			const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
			const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
			return aTime - bTime;
		});
		requestsByCollection.set(collectionId, sortedRequests);
	});

	return {
		requestsByCollection,
		isLoading: queries.some((q) => q.isLoading),
	};
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
export function useRequestQuery(requestId: string | null) {
	return useQuery({
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
		retry: (count, error) =>
			!isRequestNotFound(error) && count < QUERY_CACHE.REQUEST_LOOKUP_RETRY,
		retryDelay: QUERY_CACHE.REQUEST_LOOKUP_RETRY_DELAY_MS,
		staleTime: Infinity,
	});
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
			// Invalidate requests for this collection
			queryClient.invalidateQueries({
				queryKey: queryKeys.requests.listByCollection(deletedId),
			});
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
		},
	});
}
