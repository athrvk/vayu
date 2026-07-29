/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Name given to a freshly-created request until the user renames it. The tab
 * strip treats this placeholder as "unnamed" and falls back to the request
 * path, so keep the creation sites and that check pointing at this constant.
 */
export const DEFAULT_REQUEST_NAME = "New Request";

/**
 * Redirect policy defaults. These mirror the engine's own defaults
 * (`vayu::Request::follow_redirects` / `max_redirects` in
 * `engine/include/vayu/types.hpp`) and the `requests` table column defaults, so
 * a request saved before the Settings tab existed behaves identically to a new
 * one. The Settings tab badges only when the request differs from these.
 */
export const DEFAULT_FOLLOW_REDIRECTS = true;
export const DEFAULT_MAX_REDIRECTS = 10;

/** Bounds offered by the Settings tab; the engine clamps to the same range. */
export const MIN_MAX_REDIRECTS = 0;
export const MAX_MAX_REDIRECTS = 100;

/**
 * HTTP protocol a request asks the engine to negotiate. Wire values and
 * labels are the engine's own (`to_string`/`http_version_label` in
 * `engine/src/http/client.cpp` and the `defaultHttpVersion` config entry) -
 * `GET /config` reports this same list, so the two must not drift apart.
 *
 * The union type is derived from this array rather than declared separately:
 * adding a protocol is a one-line edit here, and every consumer (request
 * payloads, the Settings tab picker, the coercion below) follows without a
 * second place to update.
 *
 * Distinct from `ResponseState.httpVersion` (in
 * `app/src/modules/request-builder/types.ts`), which is the *negotiated*
 * protocol a response came back on - a display string like `"HTTP/2"`, not a
 * member of this union.
 */
export const HTTP_VERSIONS = [
	{ value: "auto", label: "Auto" },
	{ value: "http1.1", label: "HTTP/1.x" },
	{ value: "http2", label: "HTTP/2" },
] as const;

export type HttpVersion = (typeof HTTP_VERSIONS)[number]["value"];

export const DEFAULT_HTTP_VERSION: HttpVersion = "auto";

const HTTP_VERSION_VALUES: ReadonlySet<string> = new Set(HTTP_VERSIONS.map((v) => v.value));

/**
 * Narrow an unknown value to a {@link HttpVersion}. Lives here beside the const
 * rather than in a consumer, matching `isColorScheme` / `isUiFont` /
 * `isLiveWindow`: one derivation of the value set, so a caller never rebuilds
 * the list and never needs an `as` assertion to get the type.
 */
export function isHttpVersion(value: unknown): value is HttpVersion {
	return typeof value === "string" && HTTP_VERSION_VALUES.has(value);
}
