/**
 * Globals Transformer
 *
 * Transforms between frontend and backend global variables formats.
 */

import type { GlobalVariables, VariableValue } from "@/types";

/**
 * Backend globals response format
 */
export interface BackendGlobalsResponse {
	id: string;
	variables: Record<string, VariableValue>;
	updatedAt: number;
}

/**
 * Globals Transformer
 *
 * Handles transformation of global variables between backend and frontend formats.
 */
export class GlobalsTransformer {
	/**
	 * Transform backend globals response to frontend format
	 */
	static toFrontend(backendResponse: BackendGlobalsResponse): GlobalVariables {
		return {
			id: backendResponse.id,
			variables: backendResponse.variables || {},
			updated_at: new Date(backendResponse.updatedAt).toISOString(),
		};
	}
}
