
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection Transformer
 *
 * Transforms backend collection format to frontend format.
 * Handles date conversion (number to ISO string) for createdAt/updatedAt fields.
 */

import type { Collection } from "@/types";

/**
 * Backend collection format (camelCase with number timestamps)
 */
export type BackendCollection = Omit<Collection, "createdAt" | "updatedAt"> & {
	createdAt: number | string;
	updatedAt: number | string;
};

/**
 * Collection Transformer
 *
 * Converts backend collection (with number timestamps) to frontend format (with ISO string timestamps).
 */
export class CollectionTransformer {
	/**
	 * Transform backend collection to frontend collection
	 * Converts createdAt/updatedAt from number (Unix timestamp ms) to ISO string
	 */
	static toFrontend(backendCollection: BackendCollection): Collection {
		if (!backendCollection.id) {
			throw new Error("Collection must have an id");
		}

		// Handle createdAt/updatedAt conversion from number to string if needed
		return {
			...backendCollection,
			createdAt: new Date(backendCollection.createdAt).toISOString(),
			updatedAt: new Date(backendCollection.updatedAt).toISOString(),
		};
	}
}
