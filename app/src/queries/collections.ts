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
 * Fetch a single request by ID.
 *
 * The engine has no `GET /requests/:id` — only `GET /requests?collectionId=` —
 * so a single request is found by looking through the collection lists.
 *
 * This used to read the cache and nothing else, which made it a race it usually
 * lost on a cold start. Tabs are persisted and restored, so on launch this runs
 * immediately for every restored request tab while
 * `usePrefetchCollectionsAndRequests` is still two round trips from filling
 * those lists. It threw, retried 3× at 100ms, gave up — and because
 * `staleTime: Infinity` keeps the error parked, it never recovered once the
 * lists *did* arrive. The result was a permanent "Request not found" on the
 * restored tab, and a tab strip of anonymous "Request" labels, until you
 * clicked the request again in the sidebar.
 *
 * So it now *fetches* what it needs instead of hoping someone else already
 * did. Cache first (free), then the collection lists, hydrated through the same
 * query keys the sidebar uses so the work is shared rather than duplicated.
 * Only a request that genuinely no longer exists reaches the throw.
 */
export function useRequestQuery(requestId: string | null) {
	const queryClient = useQueryClient();

	return useQuery({
		queryKey: queryKeys.requests.detail(requestId ?? ""),
		queryFn: async () => {
			const id = requestId!;

			// Populated by mutations, and by this function on a previous miss.
			const cached = queryClient.getQueryData<Request>(queryKeys.requests.detail(id));
			if (cached) return cached;

			const scanCachedLists = () => {
				for (const [, requests] of queryClient.getQueriesData<Request[]>({
					queryKey: queryKeys.requests.lists(),
				})) {
					const found = requests?.find((r) => r.id === id);
					if (found) return found;
				}
				return undefined;
			};

			const remember = (found: Request) => {
				queryClient.setQueryData(queryKeys.requests.detail(id), found);
				return found;
			};

			const alreadyLoaded = scanCachedLists();
			if (alreadyLoaded) return remember(alreadyLoaded);

			/*
			 * Nothing cached yet. `fetchQuery` rather than `prefetchQuery`: it
			 * returns the data and, critically, dedupes against an identical
			 * in-flight request — so racing the prefetch costs no extra traffic,
			 * it just awaits the same promise.
			 */
			const collections = await queryClient.fetchQuery({
				queryKey: queryKeys.collections.list(),
				queryFn: () => apiService.listCollections(),
				staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
			});

			const lists = await Promise.all(
				collections.map((collection) =>
					queryClient
						.fetchQuery({
							queryKey: queryKeys.requests.listByCollection(collection.id),
							queryFn: () => apiService.listRequests({ collectionId: collection.id }),
							staleTime: QUERY_CACHE.DEFAULT_STALE_TIME_MS,
						})
						// One unreadable collection must not sink the others — the
						// request we want is probably in a different one.
						.catch(() => [] as Request[])
				)
			);

			for (const list of lists) {
				const found = list.find((r) => r.id === id);
				if (found) return remember(found);
			}

			throw new Error(`Request ${id} no longer exists`);
		},
		enabled: !!requestId,
		// The fetch above is authoritative, so a miss is now a real miss. One
		// retry covers a transient network blip, not a cache that has not filled.
		retry: QUERY_CACHE.REQUEST_LOOKUP_RETRY,
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
