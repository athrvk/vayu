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
	DEFAULT_STREAM,
	DEFAULT_VERIFY_SSL,
	type HttpVersion,
} from "@/constants/request";
import { createEmptyKeyValue } from "@/components/shared/KeyValueEditor/key-value";

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
	return {
		id: null,
		collectionId: null,
		name: "Untitled Request",
		method: "GET",
		url: "",
		params: [createEmptyKeyValue()],
		// No Vayu row is seeded here any more (issue #1229): the engine adds its
		// own headers at send time, so a new request starts with nothing but the
		// blank row to type into.
		headers: [createEmptyKeyValue()],
		disabledDefaultHeaders: [],
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
		verifySSL: DEFAULT_VERIFY_SSL,
		stream: DEFAULT_STREAM,
	};
};

/**
 * True when the request's settings depart from the engine defaults - the
 * rule the Settings tab badges on. It deliberately compares against the
 * defaults rather than tracking "the user opened the tab", so a request that is
 * toggled off and back on stops badging again.
 *
 * Covers the redirect policy, the protocol *and* the event-stream flag: a
 * request that only changes `httpVersion` (redirects left at their defaults)
 * must still badge, which is why this checks every field the tab owns rather
 * than being named (and scoped) after redirects alone.
 *
 * Lives here rather than in `SettingsPanel` so that file only exports its
 * component (`react-refresh/only-export-components`).
 */
export function isRequestSettingsNonDefault(
	state: Pick<
		RequestState,
		"followRedirects" | "maxRedirects" | "httpVersion" | "verifySSL" | "stream"
	>
): boolean {
	return (
		state.followRedirects !== DEFAULT_FOLLOW_REDIRECTS ||
		state.maxRedirects !== DEFAULT_MAX_REDIRECTS ||
		state.httpVersion !== DEFAULT_HTTP_VERSION ||
		state.verifySSL !== DEFAULT_VERIFY_SSL ||
		state.stream !== DEFAULT_STREAM
	);
}
