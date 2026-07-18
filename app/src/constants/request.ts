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
