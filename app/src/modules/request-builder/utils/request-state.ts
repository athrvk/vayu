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
import {
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	type HttpVersion,
} from "@/constants/request";
import { createEmptyKeyValue } from "./key-value";
import { createDefaultSystemHeaders } from "./system-headers";

/**
 * Create a default RequestState with empty values.
 *
 * `httpVersion` defaults to {@link DEFAULT_HTTP_VERSION} ("auto"). The
 * parameter exists as a seam and **no production caller passes it** - do not
 * take it as an invitation to wire one up. A new request is created
 * server-side immediately (`CollectionTree`) with no `httpVersion` in the
 * payload, so the *engine* applies its configured `defaultHttpVersion` seed
 * and the app loads the result straight back. There is no unsaved-draft phase
 * to pre-fill, and reading the global here would duplicate the engine for
 * nothing.
 */
export const createDefaultRequestState = (
	httpVersion: HttpVersion = DEFAULT_HTTP_VERSION
): RequestState => {
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
		auth: { mode: "none" },
		preRequestScript: "",
		testScript: "",
		followRedirects: DEFAULT_FOLLOW_REDIRECTS,
		maxRedirects: DEFAULT_MAX_REDIRECTS,
		httpVersion,
	};
};

/**
 * True when the request's settings depart from the engine defaults - the
 * rule the Settings tab badges on. It deliberately compares against the
 * defaults rather than tracking "the user opened the tab", so a request that is
 * toggled off and back on stops badging again.
 *
 * Covers the redirect policy *and* the protocol: a request that only changes
 * `httpVersion` (redirects left at their defaults) must still badge, which is
 * why this checks all three fields rather than being named (and scoped) after
 * redirects alone.
 *
 * Lives here rather than in `SettingsPanel` so that file only exports its
 * component (`react-refresh/only-export-components`).
 */
export function isRequestSettingsNonDefault(
	state: Pick<RequestState, "followRedirects" | "maxRedirects" | "httpVersion">
): boolean {
	return (
		state.followRedirects !== DEFAULT_FOLLOW_REDIRECTS ||
		state.maxRedirects !== DEFAULT_MAX_REDIRECTS ||
		state.httpVersion !== DEFAULT_HTTP_VERSION
	);
}
