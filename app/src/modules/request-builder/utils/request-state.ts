
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

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
