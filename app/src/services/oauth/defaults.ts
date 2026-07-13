/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { OAuth2Config } from "@/types";

/**
 * A fresh OAuth 2.0 config with sensible defaults (client-credentials, token in
 * the Authorization header as Bearer, auto-fetch/refresh on).
 */
export function defaultOAuth2Config(): OAuth2Config {
	return {
		grantType: "client_credentials",
		accessTokenUrl: "",
		clientId: "",
		clientSecret: "",
		scope: "",
		credentialsPlacement: "basic_auth_header",
		tokenPlacement: "header",
		headerPrefix: "Bearer",
		pkce: true,
		autoFetchToken: true,
		autoRefreshToken: true,
		useEmbeddedBrowser: false,
	};
}
