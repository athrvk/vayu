/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turns the engine's globals into the app's shape: `updatedAt` from a number to an ISO string.
 */

import type { GlobalVariables } from "@/types";

/**
 * Backend globals response format (camelCase with number timestamp)
 */
export type BackendGlobals = Omit<GlobalVariables, "updatedAt"> & {
	updatedAt: number | string;
};

/** Engine globals to the app's shape; see the file comment. */
export class GlobalsTransformer {
	/** `updatedAt` from Unix milliseconds to an ISO string. */
	static toFrontend(backendResponse: BackendGlobals): GlobalVariables {
		return {
			...backendResponse,
			updatedAt: new Date(backendResponse.updatedAt).toISOString(),
		};
	}
}
