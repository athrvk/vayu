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
