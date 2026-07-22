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
import { DEFAULT_FOLLOW_REDIRECTS, DEFAULT_MAX_REDIRECTS } from "@/constants/request";
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
		followRedirects: DEFAULT_FOLLOW_REDIRECTS,
		maxRedirects: DEFAULT_MAX_REDIRECTS,
	};
};

/**
 * True when the request's redirect policy departs from the engine defaults -
 * the rule the Settings tab badges on. It deliberately compares against the
 * defaults rather than tracking "the user opened the tab", so a request that is
 * toggled off and back on stops badging again.
 *
 * Lives here rather than in `SettingsPanel` so that file only exports its
 * component (`react-refresh/only-export-components`).
 */
export function isRedirectPolicyNonDefault(
	state: Pick<RequestState, "followRedirects" | "maxRedirects">
): boolean {
	return (
		state.followRedirects !== DEFAULT_FOLLOW_REDIRECTS ||
		state.maxRedirects !== DEFAULT_MAX_REDIRECTS
	);
}
