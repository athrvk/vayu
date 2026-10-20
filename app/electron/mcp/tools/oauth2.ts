/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file oauth2.ts
 * @brief The OAuth 2.0 token-cache tools' inputs, and the projections that
 *        keep a token's bytes out of their answers.
 */

import { z } from "zod";
import { isRecord } from "./kit.js";

/**
 * The `oauth2` config block, shaped as the engine reads it (`oauth_client.cpp`)
 * and as a saved request's `auth` already carries it - so an agent can lift the
 * block out of `list_requests` and hand it to `fetch_oauth2_token` unchanged.
 *
 * `passthrough` rather than an enumerated object for the same reason
 * {@link authInput} is: the engine owns which fields a grant needs, and a
 * closed schema here would refuse a config the engine accepts the day a field
 * is added. What is enumerated is the one field this layer decides on -
 * `grantType`, because the interactive grant is refused before the call.
 */
export const oauth2ConfigInput = z
	.object({
		grantType: z
			.string()
			.describe(
				"client_credentials | password. `authorization_code` is refused here - it needs a browser, so authorize it in the app."
			),
		accessTokenUrl: z.string().describe("The provider's token endpoint (http(s))."),
		clientId: z.string().describe("OAuth 2.0 client id."),
	})
	.passthrough()
	.describe(
		"The OAuth 2.0 config to acquire a token for - the same block a saved request's `auth` carries, so it can be copied from list_requests verbatim. Beyond the three required fields the engine reads clientSecret, username/password (password grant), scope, audience, resource, refreshTokenUrl, autoRefreshToken, credentialsPlacement (basic_auth_header | body), credentialsId, and the extra request parameter lists tokenParams (new token request) and refreshParams (refresh), each an array of {key, value, enabled?, sendAs?: body | url | header}, plus authorizationParams (authorize URL query, unused here). The cache key is derived from accessTokenUrl + clientId + credentialsId + username + the rows of those lists the engine would send (a credential-named row such as client_assertion by its key alone, so the key never carries the secret), so two audiences sent as rows are two tokens; configs differing only in scope, audience or resource set directly share one cached token, so set a distinct `credentialsId` to keep them apart."
	);

/** The engine-derived key one cache entry lives under. */
export const oauth2CacheKeyInput = z
	.string()
	.describe(
		"The cache key, as returned in `cacheKey` by fetch_oauth2_token (or shown by the app's auth tab). Derived engine-side from the config; there is no way to compose one here that would be guaranteed to match."
	);

/**
 * Why the interactive grant is refused rather than attempted.
 *
 * Two reasons, and the second is the load-bearing one. It cannot work: the
 * exchange needs a browser and the loopback listener `oauth_authorize.cpp`
 * binds, which the app drives and MCP has no place in. And it must not be
 * *attempted*, because `acquire_token` answers a cache hit before it ever looks
 * at the grant - so a call naming a config whose accessTokenUrl / clientId /
 * credentialsId happen to match an entry the user authorized interactively
 * would return that entry without proving anything. Refusing on `grantType`
 * closes the shape of that call rather than trusting the redaction below to
 * make it harmless.
 */
export const OAUTH2_INTERACTIVE_REFUSAL =
	'The `authorization_code` grant is not available over MCP: it redirects through a browser to a loopback listener the app owns, and an agent cannot complete that exchange. Authorize it once in Vayu (the request\'s Auth tab -> "Get New Access Token"); the token lands in the same engine cache these tools read, so get_oauth2_token_status and clear_oauth2_token work on it afterwards. For a machine-to-machine flow use `client_credentials`.';

/**
 * The engine's token record with the bearer removed.
 *
 * **The decision, stated rather than implied:** no MCP tool returns access
 * token bytes. The engine is what applies a token to a request - an agent names
 * a config and the run authenticates - so the bytes buy an agent nothing it can
 * use through Vayu, while handing them over turns a token the *user* acquired
 * (including through a browser flow no agent could complete) into something an
 * agent can carry off this machine. Everything an agent legitimately needs from
 * the cache is its shape: which key, what type, which scopes, when it expires,
 * whether a refresh token came with it.
 *
 * `accessTokenWithheld` is stated rather than left as a silent omission,
 * because an agent that finds no `accessToken` and is not told why concludes
 * the acquisition half-failed and retries with `force`.
 */
export function projectOAuth2Token(token: unknown): unknown {
	if (!isRecord(token)) return token;
	const { accessToken: _withheld, ...rest } = token;
	return { ...rest, accessTokenWithheld: true };
}

/** `GET /oauth2/token`'s answer, with the nested token record projected. */
export function projectOAuth2Status(status: unknown): unknown {
	if (!isRecord(status)) return status;
	if (!isRecord(status.token)) return status;
	return { ...status, token: projectOAuth2Token(status.token) };
}
