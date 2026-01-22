
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Globals Transformer
 *
 * Transforms backend globals format to frontend format.
 * Handles date conversion (number to ISO string) for updatedAt field.
 */

import type { GlobalVariables } from "@/types";

/**
 * Backend globals response format (camelCase with number timestamp)
 */
export type BackendGlobals = Omit<GlobalVariables, "updatedAt"> & {
	updatedAt: number | string;
}

/**
 * Globals Transformer
 *
 * Converts backend globals (with number timestamp) to frontend format (with ISO string timestamp).
 */
export class GlobalsTransformer {
	/**
	 * Transform backend globals response to frontend format
	 * Converts updatedAt from number (Unix timestamp ms) to ISO string
	 */
	static toFrontend(backendResponse: BackendGlobals): GlobalVariables {
		return {
			...backendResponse,
			updatedAt: new Date(backendResponse.updatedAt).toISOString(),
		};
	}
}
