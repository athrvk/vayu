/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Creating and inspecting `RequestState`. */

import type { RequestState } from "../types";
import {
	DEFAULT_DISABLE_COOKIES,
	DEFAULT_DISABLE_URL_ENCODING,
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_STREAM,
	DEFAULT_STREAM_FIRST_CONTENT_MARKER,
	DEFAULT_STREAM_TEXT_PATH,
	DEFAULT_VERIFY_SSL,
	type HttpVersion,
} from "@/constants/request";
import { createEmptyKeyValue } from "@/components/shared/KeyValueEditor/key-value";
import { noFile } from "@/lib/file-trust";

/**
 * A default `RequestState`. `httpVersion` defaults to {@link DEFAULT_HTTP_VERSION} ("auto"); the
 * parameter is a seam **no production caller passes**, and should not be wired: a new request is
 * created server-side at once (`CollectionTree`) without `httpVersion`, so the engine applies its
 * `defaultHttpVersion` seed and the app loads the result. There is no draft phase to pre-fill, and
 * reading the global here would duplicate the engine.
 */
export const createDefaultRequestState = (
	httpVersion: HttpVersion = DEFAULT_HTTP_VERSION
): RequestState => {
	return {
		id: null,
		collectionId: null,
		name: "Untitled request",
		method: "GET",
		url: "",
		params: [createEmptyKeyValue()],
		// No Vayu row is seeded (#1229): the engine adds its headers at send time, so a new request
		// starts with only the blank row.
		headers: [createEmptyKeyValue()],
		disabledDefaultHeaders: [],
		bodyMode: "none",
		body: "",
		formData: [createEmptyKeyValue()],
		urlEncoded: [createEmptyKeyValue()],
		binaryFile: noFile(),
		auth: { mode: "none" },
		elements: [],
		followRedirects: DEFAULT_FOLLOW_REDIRECTS,
		maxRedirects: DEFAULT_MAX_REDIRECTS,
		timeout: null,
		httpVersion,
		verifySSL: DEFAULT_VERIFY_SSL,
		disableCookies: DEFAULT_DISABLE_COOKIES,
		disabledSystemHeaders: [],
		disableUrlEncoding: DEFAULT_DISABLE_URL_ENCODING,
		stream: DEFAULT_STREAM,
		streamTextPath: DEFAULT_STREAM_TEXT_PATH,
		streamFirstContentMarker: DEFAULT_STREAM_FIRST_CONTENT_MARKER,
	};
};

/**
 * Whether the settings depart from the engine defaults, the rule the Settings tab badges on,
 * compared against defaults rather than "opened the tab", so toggling off and on stops the badge.
 * Covers redirects, the timeout (any number badges; `null` is default), protocol, the event-stream
 * flag with its text path and first content marker, and Postman's protocol switches (#1765): a
 * request changing only `httpVersion` must badge, so every field the tab owns is checked. Here, not
 * in `SettingsPanel`, so that file exports only its component
 * (`react-refresh/only-export-components`).
 */
export function isRequestSettingsNonDefault(
	state: Pick<
		RequestState,
		| "followRedirects"
		| "maxRedirects"
		| "timeout"
		| "httpVersion"
		| "verifySSL"
		| "stream"
		| "streamTextPath"
		| "streamFirstContentMarker"
		| "disableCookies"
		| "disabledSystemHeaders"
		| "disableUrlEncoding"
	>
): boolean {
	return (
		state.followRedirects !== DEFAULT_FOLLOW_REDIRECTS ||
		state.maxRedirects !== DEFAULT_MAX_REDIRECTS ||
		state.timeout !== null ||
		state.httpVersion !== DEFAULT_HTTP_VERSION ||
		state.verifySSL !== DEFAULT_VERIFY_SSL ||
		state.stream !== DEFAULT_STREAM ||
		state.streamTextPath !== DEFAULT_STREAM_TEXT_PATH ||
		state.streamFirstContentMarker !== DEFAULT_STREAM_FIRST_CONTENT_MARKER ||
		state.disableCookies !== DEFAULT_DISABLE_COOKIES ||
		state.disabledSystemHeaders.length > 0 ||
		state.disableUrlEncoding !== DEFAULT_DISABLE_URL_ENCODING
	);
}
