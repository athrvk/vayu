
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Request Transformer
 *
 * Transforms backend request format to frontend format.
 * Handles date conversion (number to ISO string) for createdAt/updatedAt fields.
 */

import type { Request } from "@/types";

/**
 * Backend request format (camelCase with number timestamps)
 */
export type BackendRequest = Omit<Request, "createdAt" | "updatedAt"> & {
	createdAt: number | string;
	updatedAt: number | string;
};

/**
 * Request Transformer
 *
 * Converts backend request (with number timestamps) to frontend format (with ISO string timestamps).
 */
export class RequestTransformer {
	/**
	 * Transform backend request to frontend request
	 * Converts createdAt/updatedAt from number (Unix timestamp ms) to ISO string
	 */
	static toFrontend(backendRequest: BackendRequest): Request {
		if (!backendRequest.id) {
			throw new Error("Request must have an id");
		}

		// Handle createdAt/updatedAt conversion from number to string if needed
		return {
			...backendRequest,
			createdAt: new Date(backendRequest.createdAt).toISOString(),
			updatedAt: new Date(backendRequest.updatedAt).toISOString(),
		};
	}
}
