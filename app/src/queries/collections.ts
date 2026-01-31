
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
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
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
						staleTime: 30 * 1000, // Consider fresh for 30 seconds
					})
				)
			);
			return true;
		},
		enabled: collections.length > 0,
		staleTime: 30 * 1000, // Re-prefetch after 30 seconds
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

	// Build a map of collectionId -> requests (sorted by createdAt for stable order)
	const requestsByCollection = new Map<string, Request[]>();
	queries.forEach((query, index) => {
		const collectionId = collectionIds[index];
		const requests = query.data ?? [];
		// Sort by createdAt to maintain stable order after renames
		const sortedRequests = [...requests].sort((a, b) => {
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
 * Fetch a single request by ID
 *
 * This looks up the request from the cache since there's no dedicated
 * GET /requests/:id endpoint. First checks the detail cache (set by mutations),
 * then falls back to searching through collection request lists.
 */
export function useRequestQuery(requestId: string | null) {
	const queryClient = useQueryClient();

	return useQuery({
		queryKey: queryKeys.requests.detail(requestId ?? ""),
		queryFn: () => {
			// First check if we already have this request in detail cache
			const cached = queryClient.getQueryData<Request>(queryKeys.requests.detail(requestId!));
			if (cached) return cached;

			// Search through all cached request lists to find this one
			const queriesData = queryClient.getQueriesData<Request[]>({
				queryKey: queryKeys.requests.lists(),
			});

			for (const [, requests] of queriesData) {
				if (requests) {
					const found = requests.find((r) => r.id === requestId);
					if (found) {
						// Also populate the detail cache for next time
						queryClient.setQueryData(queryKeys.requests.detail(requestId!), found);
						return found;
					}
				}
			}

			throw new Error(`Request ${requestId} not found in cache`);
		},
		enabled: !!requestId,
		// Retry a few times with short delay - the cache might be updating
		retry: 3,
		retryDelay: 100,
		// Use stale data since we're reading from cache
		staleTime: Infinity,
	});
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
			queryClient.setQueryData<Collection[]>(
				queryKeys.collections.list(),
				(old) => {
					const next =
						old?.map((c) => (c.id === updatedCollection.id ? updatedCollection : c)) ?? [];
					return next.sort(compareCollectionOrder);
				}
			);
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
