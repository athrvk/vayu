// Collections State Store

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Collection, Request } from "@/types";

interface CollectionsState {
	collections: Collection[];
	requests: Record<string, Request[]>; // Keyed by collection_id
	isLoading: boolean;
	error: string | null;
	expandedCollectionIds: Set<string>;

	// Actions
	setCollections: (collections: Collection[]) => void;
	setRequests: (collectionId: string, requests: Request[]) => void;
	addCollection: (collection: Collection) => void;
	updateCollection: (collection: Collection) => void;
	removeCollection: (collectionId: string) => void;
	addRequest: (request: Request) => void;
	updateRequest: (request: Request) => void;
	removeRequest: (requestId: string) => void;
	toggleCollectionExpanded: (collectionId: string) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;

	// Helpers
	getRequestsByCollection: (collectionId: string) => Request[];
	getRequestById: (requestId: string) => Request | undefined;
	getCollectionById: (collectionId: string) => Collection | undefined;
}

export const useCollectionsStore = create<CollectionsState>()(
	persist(
		(set, get) => ({
			collections: [],
			requests: {},
			isLoading: false,
			error: null,
			expandedCollectionIds: new Set<string>(),

	setCollections: (collections) => set({ collections }),

	setRequests: (collectionId, requests) =>
		set((state) => ({
			requests: { ...state.requests, [collectionId]: requests },
		})),

	addCollection: (collection) =>
		set((state) => ({
			collections: [...state.collections, collection],
		})),

	updateCollection: (collection) =>
		set((state) => ({
			collections: state.collections.map((c) =>
				c.id === collection.id ? collection : c
			),
		})),

	removeCollection: (collectionId) =>
		set((state) => {
			const { [collectionId]: _, ...remainingRequests } = state.requests;
			return {
				collections: state.collections.filter((c) => c.id !== collectionId),
				requests: remainingRequests,
			};
		}),

	addRequest: (request) =>
		set((state) => {
			const collectionRequests = state.requests[request.collection_id] || [];
			return {
				requests: {
					...state.requests,
					[request.collection_id]: [...collectionRequests, request],
				},
			};
		}),

	updateRequest: (request) =>
		set((state) => {
			const collectionRequests = state.requests[request.collection_id] || [];
			return {
				requests: {
					...state.requests,
					[request.collection_id]: collectionRequests.map((r) =>
						r.id === request.id ? request : r
					),
				},
			};
		}),

	removeRequest: (requestId) =>
		set((state) => {
			const newRequests: Record<string, Request[]> = {};
			Object.entries(state.requests).forEach(([collectionId, requests]) => {
				newRequests[collectionId] = requests.filter((r) => r.id !== requestId);
			});
			return { requests: newRequests };
		}),

	toggleCollectionExpanded: (collectionId) =>
		set((state) => {
			const newExpanded = new Set(state.expandedCollectionIds);
			if (newExpanded.has(collectionId)) {
				newExpanded.delete(collectionId);
			} else {
				newExpanded.add(collectionId);
			}
			return { expandedCollectionIds: newExpanded };
		}),

	setLoading: (loading) => set({ isLoading: loading }),
	setError: (error) => set({ error }),

	// Helpers
	getRequestsByCollection: (collectionId) => {
		return get().requests[collectionId] || [];
	},

	getRequestById: (requestId) => {
		const { requests } = get();
		for (const collectionRequests of Object.values(requests)) {
			const request = collectionRequests.find((r) => r.id === requestId);
			if (request) return request;
		}
		return undefined;
	},

	getCollectionById: (collectionId) => {
		return get().collections.find((c) => c.id === collectionId);
	},
		}),
		{
			name: "collections-store", // localStorage key
			partialize: (state) => ({
				collections: state.collections,
				requests: state.requests,
			}), // Only persist collections and requests, not UI state
		}
	)
);
