// useCollections Hook - Load and manage collections/requests

import { useState, useCallback } from "react";
import { apiService } from "@/services";
import { useCollectionsStore } from "@/stores";
import type {
	Collection,
	Request,
	CreateCollectionRequest,
	CreateRequestRequest,
} from "@/types";

interface UseCollectionsReturn {
	collections: Collection[];
	loadCollections: () => Promise<void>;
	loadRequestsForCollection: (collectionId: string) => Promise<void>;
	createCollection: (
		data: CreateCollectionRequest
	) => Promise<Collection | null>;
	createRequest: (data: CreateRequestRequest) => Promise<Request | null>;
	updateCollection: (
		id: string,
		data: { name?: string; parent_id?: string }
	) => Promise<boolean>;
	deleteCollection: (collectionId: string) => Promise<boolean>;
	deleteRequest: (requestId: string) => Promise<boolean>;
	isLoading: boolean;
	error: string | null;
}

export function useCollections(): UseCollectionsReturn {
	const {
		collections,
		setCollections,
		setRequests,
		addCollection,
		addRequest,
		removeCollection,
		removeRequest,
		setLoading: setStoreLoading,
		setError: setStoreError,
		setSavingCollection,
		setSavingRequest,
	} = useCollectionsStore();

	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadCollections = useCallback(async () => {
		setIsLoading(true);
		setStoreLoading(true);
		setError(null);
		setStoreError(null);

		try {
			console.log("Loading collections...");
			const loadedCollections = await apiService.listCollections();
			console.log("Collections loaded:", loadedCollections);
			setCollections(loadedCollections);
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Failed to load collections";
			console.error("Failed to load collections:", err);
			setError(errorMessage);
			setStoreError(errorMessage);
		} finally {
			setIsLoading(false);
			setStoreLoading(false);
		}
	}, [setCollections, setStoreLoading, setStoreError]);

	const loadRequestsForCollection = useCallback(
		async (collectionId: string) => {
			try {
				console.log("Loading requests for collection:", collectionId);
				const requests = await apiService.listRequests({
					collection_id: collectionId,
				});
				console.log("Requests loaded for collection", collectionId, ":", requests);
				setRequests(collectionId, requests);
			} catch (err) {
				console.error("Failed to load requests:", err);
			}
		},
		[setRequests]
	);

	const createCollection = useCallback(
		async (data: CreateCollectionRequest): Promise<Collection | null> => {
			setError(null);
			setSavingCollection(true);
			try {
				console.log("Creating collection with data:", data);
				const collection = await apiService.createCollection(data);
				console.log("Collection created:", collection);
				addCollection(collection);
				return collection;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to create collection";
				console.error("Failed to create collection:", err);
				setError(errorMessage);
				return null;
			} finally {
				setSavingCollection(false);
			}
		},
		[addCollection, setSavingCollection]
	);

	const createRequest = useCallback(
		async (data: CreateRequestRequest): Promise<Request | null> => {
			setError(null);
			setSavingRequest(true);
			try {
				console.log("Creating request with data:", data);
				const request = await apiService.createRequest(data);
				console.log("Request created successfully:", request);
				
				// Add request to store immediately (since backend GET /requests is broken)
				addRequest(request);
				
				// Try to reload from backend (but don't fail if it doesn't work)
				try {
					console.log("Reloading requests for collection:", data.collection_id);
					await loadRequestsForCollection(data.collection_id);
				} catch (reloadErr) {
					console.warn("Failed to reload requests from backend, using local data:", reloadErr);
				}
				
				return request;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to create request";
				console.error("Failed to create request:", err);
				setError(errorMessage);
				return null;
			} finally {
				setSavingRequest(false);
			}
		},
		[addRequest, loadRequestsForCollection, setSavingRequest]
	);

	const updateCollection = useCallback(
		async (
			id: string,
			data: { name?: string; parent_id?: string }
		): Promise<boolean> => {
			setError(null);
			setSavingCollection(true);
			try {
				console.log("Updating collection", id, "with data:", data);
				await apiService.updateCollection({ id, ...data });
				// Reload collections to get updated data
				await loadCollections();
				return true;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to update collection";
				console.error("Failed to update collection:", err);
				setError(errorMessage);
				return false;
			} finally {
				setSavingCollection(false);
			}
		},
		[loadCollections, setSavingCollection]
	);

	const deleteCollection = useCallback(
		async (collectionId: string): Promise<boolean> => {
			setError(null);
			setSavingCollection(true);
			try {
				await apiService.deleteCollection(collectionId);
				removeCollection(collectionId);
				return true;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to delete collection";
				setError(errorMessage);
				return false;
			} finally {
				setSavingCollection(false);
			}
		},
		[removeCollection, setSavingCollection]
	);

	const deleteRequest = useCallback(
		async (requestId: string): Promise<boolean> => {
			setError(null);
			setSavingRequest(true);
			try {
				await apiService.deleteRequest(requestId);
				removeRequest(requestId);
				return true;
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Failed to delete request";
				setError(errorMessage);
				return false;
			} finally {
				setSavingRequest(false);
			}
		},
		[removeRequest, setSavingRequest]
	);

	return {
		collections,
		loadCollections,
		loadRequestsForCollection,
		createCollection,
		createRequest,
		updateCollection,
		deleteCollection,
		deleteRequest,
		isLoading,
		error,
	};
}
