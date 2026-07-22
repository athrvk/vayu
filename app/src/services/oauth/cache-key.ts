/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { OAuth2Config } from "@/types";

/**
 * Compute the token cache key for an OAuth 2.0 config.
 *
 * MUST stay byte-identical with the engine's vayu::http::oauth::cache_key
 * (engine/src/http/oauth_client.cpp) - both sides key the token cache by this
 * string, and the shared test vectors in cache-key.test.ts / oauth_client_test.cpp
 * pin the format:
 *
 *   accessTokenUrl \x1f clientId \x1f (credentialsId|"default")
 *   \x1f (grantType === "password" ? username : "")
 *
 * Note: `scope`/`audience`/`resource` are intentionally omitted (matches
 * Postman's keying). Configs differing only in scope share a cached token; set a
 * distinct credentialsId to separate them.
 */
export function computeOAuth2CacheKey(config: OAuth2Config): string {
	const US = "\x1f"; // unit separator
	const credentialsId = config.credentialsId || "default";
	const username = config.grantType === "password" ? (config.username ?? "") : "";
	return [config.accessTokenUrl ?? "", config.clientId ?? "", credentialsId, username].join(US);
}
