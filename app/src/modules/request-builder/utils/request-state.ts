/**
 * Request State Utilities
 *
 * Utilities for creating and managing RequestState
 */

import type { RequestState } from "../types";
import { createEmptyKeyValue } from "./key-value";
import { createDefaultSystemHeaders } from "./system-headers";

/**
 * Create a default RequestState with empty values
 */
export const createDefaultRequestState = (): RequestState => {
	const systemHeaders = createDefaultSystemHeaders();
	return {
		id: null,
		collectionId: null,
		name: "Untitled Request",
		method: "GET",
		url: "",
		params: [createEmptyKeyValue()],
		headers: [...systemHeaders, createEmptyKeyValue()],
		bodyMode: "none",
		body: "",
		formData: [createEmptyKeyValue()],
		urlEncoded: [createEmptyKeyValue()],
		authType: "none",
		authConfig: {},
		preRequestScript: "",
		testScript: "",
	};
};
