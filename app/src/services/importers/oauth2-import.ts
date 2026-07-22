/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth 2.0 import mapping. Turns each source format's oauth2 block into Vayu's
 * typed {@link OAuth2Config}. Kept in one place so the Postman/Insomnia/OpenAPI
 * importers share the grant-type normalization and defaults.
 *
 * Field references: docs/oauth/02-postman-bruno.md §1.5 (Postman v2.1 keys).
 */

import { defaultOAuth2Config } from "@/services/oauth/defaults";
import type { OAuth2Config, OAuth2GrantType, RequestAuth } from "@/types";
import { normalizeVars } from "./var-normalize";

function nv(value: unknown): string {
	return normalizeVars(value == null ? "" : String(value));
}

function base(): OAuth2Config {
	return defaultOAuth2Config();
}

/**
 * Postman collection v2.1 `oauth2` params (already flattened to key/value).
 * A minimal export carrying only a pre-fetched `accessToken` imports as a
 * bearer token (immediately executable).
 */
export function mapPostmanOAuth2(d: Record<string, string>): RequestAuth {
	if (!d.grant_type && !d.accessTokenUrl && !d.authUrl && d.accessToken) {
		return { mode: "bearer", token: nv(d.accessToken) };
	}

	let grantType: OAuth2GrantType = "client_credentials";
	let pkce = false;
	switch (d.grant_type) {
		case "authorization_code":
			grantType = "authorization_code";
			break;
		case "authorization_code_with_pkce":
			grantType = "authorization_code";
			pkce = true;
			break;
		case "password_credentials":
			grantType = "password";
			break;
		case "client_credentials":
			grantType = "client_credentials";
			break;
		case "implicit":
			// Vayu has no implicit grant; map to auth code + PKCE.
			grantType = "authorization_code";
			pkce = true;
			break;
	}
	if (d.challengeAlgorithm) pkce = true;

	const config: OAuth2Config = {
		...base(),
		grantType,
		pkce,
		authorizationUrl: nv(d.authUrl),
		accessTokenUrl: nv(d.accessTokenUrl),
		refreshTokenUrl: nv(d.refreshTokenUrl),
		callbackUrl: nv(d.redirect_uri),
		clientId: nv(d.clientId),
		clientSecret: nv(d.clientSecret),
		scope: nv(d.scope),
		username: nv(d.username),
		password: nv(d.password),
		credentialsPlacement: d.client_authentication === "body" ? "body" : "basic_auth_header",
		tokenPlacement: d.addTokenTo === "queryParams" ? "query" : "header",
		headerPrefix: d.headerPrefix ? nv(d.headerPrefix) : "Bearer",
		// Postman "useBrowser" = authorize via system browser; embedded is the inverse.
		useEmbeddedBrowser: d.useBrowser === "false",
	};
	return { mode: "oauth2", config };
}

/**
 * Insomnia v4 oauth2 auth object (camelCase keys).
 */
export function mapInsomniaOAuth2(auth: Record<string, unknown>): RequestAuth {
	let grantType: OAuth2GrantType = "client_credentials";
	let pkce = auth.usePkce === true;
	switch (auth.grantType) {
		case "authorization_code":
			grantType = "authorization_code";
			break;
		case "password":
			grantType = "password";
			break;
		case "client_credentials":
			grantType = "client_credentials";
			break;
		case "implicit":
			grantType = "authorization_code";
			pkce = true;
			break;
	}

	const config: OAuth2Config = {
		...base(),
		grantType,
		pkce,
		authorizationUrl: nv(auth.authorizationUrl),
		accessTokenUrl: nv(auth.accessTokenUrl),
		callbackUrl: nv(auth.redirectUrl),
		clientId: nv(auth.clientId),
		clientSecret: nv(auth.clientSecret),
		scope: nv(auth.scope),
		username: nv(auth.username),
		password: nv(auth.password),
		audience: nv(auth.audience),
		resource: nv(auth.resource),
		credentialsPlacement: auth.credentialsInBody === true ? "body" : "basic_auth_header",
	};
	return { mode: "oauth2", config };
}

// Client credentials are never in an OpenAPI spec; seed variable placeholders.
function openApiBase(): OAuth2Config {
	return { ...base(), clientId: "{{clientId}}", clientSecret: "{{clientSecret}}" };
}

function scopeString(scopes: unknown): string {
	return scopes && typeof scopes === "object" ? Object.keys(scopes).join(" ") : "";
}

/**
 * OpenAPI 3 oauth2 securityScheme - pick the first usable flow.
 */
export function mapOpenApiV3OAuth2(scheme: Record<string, unknown>): RequestAuth {
	const flows = (scheme.flows ?? {}) as Record<string, Record<string, unknown>>;
	if (flows.clientCredentials) {
		return {
			mode: "oauth2",
			config: {
				...openApiBase(),
				grantType: "client_credentials",
				accessTokenUrl: nv(flows.clientCredentials.tokenUrl),
				scope: scopeString(flows.clientCredentials.scopes),
			},
		};
	}
	if (flows.authorizationCode) {
		return {
			mode: "oauth2",
			config: {
				...openApiBase(),
				grantType: "authorization_code",
				pkce: true,
				authorizationUrl: nv(flows.authorizationCode.authorizationUrl),
				accessTokenUrl: nv(flows.authorizationCode.tokenUrl),
				scope: scopeString(flows.authorizationCode.scopes),
			},
		};
	}
	if (flows.password) {
		return {
			mode: "oauth2",
			config: {
				...openApiBase(),
				grantType: "password",
				accessTokenUrl: nv(flows.password.tokenUrl),
				scope: scopeString(flows.password.scopes),
			},
		};
	}
	if (flows.implicit) {
		return {
			mode: "oauth2",
			config: {
				...openApiBase(),
				grantType: "authorization_code",
				pkce: true,
				authorizationUrl: nv(flows.implicit.authorizationUrl),
				scope: scopeString(flows.implicit.scopes),
			},
		};
	}
	return { mode: "oauth2", config: openApiBase() };
}

/**
 * Swagger 2 oauth2 securityScheme (single `flow` field).
 */
export function mapSwaggerOAuth2(scheme: Record<string, unknown>): RequestAuth {
	const scope = scopeString(scheme.scopes);
	switch (scheme.flow) {
		case "application":
			return {
				mode: "oauth2",
				config: {
					...openApiBase(),
					grantType: "client_credentials",
					accessTokenUrl: nv(scheme.tokenUrl),
					scope,
				},
			};
		case "accessCode":
			return {
				mode: "oauth2",
				config: {
					...openApiBase(),
					grantType: "authorization_code",
					pkce: true,
					authorizationUrl: nv(scheme.authorizationUrl),
					accessTokenUrl: nv(scheme.tokenUrl),
					scope,
				},
			};
		case "password":
			return {
				mode: "oauth2",
				config: {
					...openApiBase(),
					grantType: "password",
					accessTokenUrl: nv(scheme.tokenUrl),
					scope,
				},
			};
		case "implicit":
			return {
				mode: "oauth2",
				config: {
					...openApiBase(),
					grantType: "authorization_code",
					pkce: true,
					authorizationUrl: nv(scheme.authorizationUrl),
					scope,
				},
			};
		default:
			return { mode: "oauth2", config: openApiBase() };
	}
}
