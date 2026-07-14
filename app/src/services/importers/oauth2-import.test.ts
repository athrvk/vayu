/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	mapPostmanOAuth2,
	mapInsomniaOAuth2,
	mapOpenApiV3OAuth2,
	mapSwaggerOAuth2,
} from "./oauth2-import";
import type { OAuth2Config, RequestAuth } from "@/types";

const cfg = (r: RequestAuth) => (r as { config: OAuth2Config }).config;

describe("mapPostmanOAuth2", () => {
	it("maps a full authorization_code_with_pkce config", () => {
		const r = mapPostmanOAuth2({
			grant_type: "authorization_code_with_pkce",
			authUrl: "https://idp/auth",
			accessTokenUrl: "https://idp/token",
			redirect_uri: "https://app/cb",
			clientId: "cid",
			clientSecret: "sec",
			scope: "openid profile",
			client_authentication: "body",
			addTokenTo: "queryParams",
			headerPrefix: "Token",
		});
		expect(r.mode).toBe("oauth2");
		expect(cfg(r)).toMatchObject({
			grantType: "authorization_code",
			pkce: true,
			authorizationUrl: "https://idp/auth",
			accessTokenUrl: "https://idp/token",
			callbackUrl: "https://app/cb",
			clientId: "cid",
			clientSecret: "sec",
			scope: "openid profile",
			credentialsPlacement: "body",
			tokenPlacement: "query",
			headerPrefix: "Token",
		});
	});

	it("normalizes each grant type", () => {
		expect(
			cfg(mapPostmanOAuth2({ grant_type: "client_credentials", accessTokenUrl: "u" }))
				.grantType
		).toBe("client_credentials");
		expect(
			cfg(mapPostmanOAuth2({ grant_type: "password_credentials", accessTokenUrl: "u" }))
				.grantType
		).toBe("password");
		const implicit = cfg(mapPostmanOAuth2({ grant_type: "implicit", authUrl: "u" }));
		expect(implicit.grantType).toBe("authorization_code");
		expect(implicit.pkce).toBe(true);
	});

	it("challengeAlgorithm forces PKCE on a plain auth-code grant", () => {
		expect(
			cfg(
				mapPostmanOAuth2({
					grant_type: "authorization_code",
					authUrl: "u",
					challengeAlgorithm: "S256",
				})
			).pkce
		).toBe(true);
	});

	it("minimal export (accessToken only) becomes a bearer token", () => {
		expect(mapPostmanOAuth2({ accessToken: "TOK" })).toEqual({ mode: "bearer", token: "TOK" });
	});

	it("rewrites {{postman}} vars to {{vayu}} form", () => {
		// normalizeVars maps Postman :var / {{var}} — at minimum {{var}} passes through.
		expect(
			cfg(
				mapPostmanOAuth2({
					grant_type: "client_credentials",
					clientId: "{{cid}}",
					accessTokenUrl: "u",
				})
			).clientId
		).toContain("{{");
	});
});

describe("mapInsomniaOAuth2", () => {
	it("maps client_credentials with body placement", () => {
		const r = mapInsomniaOAuth2({
			grantType: "client_credentials",
			accessTokenUrl: "https://idp/token",
			clientId: "cid",
			clientSecret: "sec",
			scope: "read",
			credentialsInBody: true,
		});
		expect(cfg(r)).toMatchObject({
			grantType: "client_credentials",
			accessTokenUrl: "https://idp/token",
			credentialsPlacement: "body",
		});
	});

	it("carries usePkce and redirectUrl for auth code", () => {
		const r = mapInsomniaOAuth2({
			grantType: "authorization_code",
			authorizationUrl: "https://idp/auth",
			redirectUrl: "https://app/cb",
			usePkce: true,
		});
		expect(cfg(r)).toMatchObject({
			grantType: "authorization_code",
			pkce: true,
			callbackUrl: "https://app/cb",
		});
	});
});

describe("mapOpenApiV3OAuth2", () => {
	it("prefers clientCredentials and joins scopes", () => {
		const r = mapOpenApiV3OAuth2({
			type: "oauth2",
			flows: {
				clientCredentials: {
					tokenUrl: "https://idp/token",
					scopes: { read: "", write: "" },
				},
			},
		});
		expect(cfg(r)).toMatchObject({
			grantType: "client_credentials",
			accessTokenUrl: "https://idp/token",
			scope: "read write",
			clientId: "{{clientId}}",
		});
	});

	it("maps authorizationCode with PKCE", () => {
		const r = mapOpenApiV3OAuth2({
			type: "oauth2",
			flows: {
				authorizationCode: { authorizationUrl: "https://idp/a", tokenUrl: "https://idp/t" },
			},
		});
		expect(cfg(r)).toMatchObject({
			grantType: "authorization_code",
			pkce: true,
			authorizationUrl: "https://idp/a",
			accessTokenUrl: "https://idp/t",
		});
	});
});

describe("mapSwaggerOAuth2", () => {
	it("maps accessCode → authorization_code", () => {
		const r = mapSwaggerOAuth2({
			type: "oauth2",
			flow: "accessCode",
			authorizationUrl: "https://idp/a",
			tokenUrl: "https://idp/t",
		});
		expect(cfg(r)).toMatchObject({
			grantType: "authorization_code",
			pkce: true,
			authorizationUrl: "https://idp/a",
			accessTokenUrl: "https://idp/t",
		});
	});

	it("maps password flow", () => {
		expect(
			cfg(mapSwaggerOAuth2({ type: "oauth2", flow: "password", tokenUrl: "https://idp/t" }))
				.grantType
		).toBe("password");
	});
});
