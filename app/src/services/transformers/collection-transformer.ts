
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection Transformer
 *
 * Transforms between frontend (snake_case) and backend (camelCase) collection formats.
 */

import type { Collection, CreateCollectionRequest, UpdateCollectionRequest } from "@/types";

/**
 * Backend collection format (camelCase)
 */
export interface BackendCollection {
	id?: string;
	name: string;
	description?: string;
	parentId?: string;
	variables?: Record<string, any>;
	order?: number;
	createdAt?: string | number;
	updatedAt?: string | number;
	// Also support snake_case for backward compatibility
	parent_id?: string;
	created_at?: string;
	updated_at?: string;
}

/**
 * Collection Transformer
 *
 * Handles transformation between frontend (snake_case) and backend (camelCase) formats.
 */
export class CollectionTransformer {
	/**
	 * Transform backend collection (camelCase) to frontend collection (snake_case)
	 */
	static toFrontend(backendCollection: BackendCollection): Collection {
		if (!backendCollection.id) {
			throw new Error("Collection must have an id");
		}

		return {
			id: backendCollection.id,
			name: backendCollection.name,
			description: backendCollection.description,
			parent_id: backendCollection.parentId || backendCollection.parent_id,
			order: backendCollection.order,
			variables: backendCollection.variables,
			created_at: backendCollection.createdAt
				? typeof backendCollection.createdAt === "string"
					? backendCollection.createdAt
					: new Date(backendCollection.createdAt).toISOString()
				: backendCollection.created_at || new Date().toISOString(),
			updated_at: backendCollection.updatedAt
				? typeof backendCollection.updatedAt === "string"
					? backendCollection.updatedAt
					: new Date(backendCollection.updatedAt).toISOString()
				: backendCollection.updated_at || new Date().toISOString(),
		};
	}

	/**
	 * Transform frontend collection (snake_case) to backend collection (camelCase)
	 */
	static toBackend(
		data: CreateCollectionRequest | UpdateCollectionRequest
	): Partial<BackendCollection> {
		const backendData: Partial<BackendCollection> = {
			name: data.name,
		};

		// Handle ID for updates
		if ("id" in data && data.id) {
			backendData.id = data.id;
		}

		// Handle description
		if (data.description !== undefined) {
			backendData.description = data.description;
		}

		// Handle parent ID
		if (data.parent_id) {
			backendData.parentId = data.parent_id;
		}

		// Handle variables
		if (data.variables) {
			backendData.variables = data.variables;
		}

		return backendData;
	}
}
