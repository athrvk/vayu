/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { computeOAuth2CacheKey } from "./cache-key";
import type { OAuth2Config } from "@/types";

// These vectors are shared VERBATIM with engine/tests/oauth_client_test.cpp
// (OAuthCacheKey.SharedVectors). The engine and app must agree byte-for-byte or
// the token cache will never hit across the HTTP boundary.
const base = (over: Partial<OAuth2Config>): OAuth2Config => ({
	grantType: "client_credentials",
	accessTokenUrl: "https://idp/token",
	clientId: "cid",
	...over,
});

describe("computeOAuth2CacheKey - shared vectors", () => {
	it("vector 1: minimal client_credentials", () => {
		expect(computeOAuth2CacheKey(base({}))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
	});

	it("vector 2: password grant with credentialsId", () => {
		expect(
			computeOAuth2CacheKey(
				base({ grantType: "password", credentialsId: "work", username: "u1" })
			)
		).toBe("https://idp/token\x1fcid\x1fwork\x1fpassword\x1fu1");
	});

	it("vector 3: username ignored outside password grant", () => {
		expect(computeOAuth2CacheKey(base({ username: "u1" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
	});

	it("vector 4: all three lists, unsorted rows, mixed sendAs", () => {
		expect(
			computeOAuth2CacheKey(
				base({
					refreshParams: [{ key: "audience", value: "api" }],
					tokenParams: [
						{ key: "tenant", value: "t1", sendAs: "url" },
						{ key: "audience", value: "b" },
						{ key: "audience", value: "a", sendAs: "header" },
					],
					authorizationParams: [{ key: "prompt", value: "login" }],
				})
			)
		).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f" +
				"\x1fauthorizationParams:prompt=login" +
				"\x1ftokenParams:audience=a\x1eaudience=b\x1etenant=t1" +
				"\x1frefreshParams:audience=api"
		);
	});

	it("vector 5: rows the engine would never send add nothing", () => {
		// The malformed shapes are the point, so the config is typed loosely: a
		// stored config is whatever JSON the engine round-tripped.
		const malformed = {
			tokenParams: [
				{ key: "a", value: "1", enabled: false },
				{ key: "", value: "1" },
				{ key: 7, value: "1" },
				{ key: "scope", value: "x" },
				{ key: "b", value: "1", sendAs: "cookie" },
				"row",
				3,
			],
			refreshParams: "audience=api",
			authorizationParams: [{ key: "n", value: 5 }],
		} as unknown as Partial<OAuth2Config>;
		expect(computeOAuth2CacheKey(base(malformed))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f\x1fauthorizationParams:n="
		);
	});

	it("vector 6: a credential-named row is keyed by its name alone", () => {
		expect(
			computeOAuth2CacheKey(
				base({
					tokenParams: [
						{ key: "client_assertion", value: "eyJhbGciOi.e30.sig" },
						{ key: "X-Api-Key", value: "k-123", sendAs: "header" },
						{ key: "audience", value: "api" },
					],
				})
			)
		).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f" +
				"\x1ftokenParams:X-Api-Key=\x1eaudience=api\x1eclient_assertion="
		);
	});

	it("vector 7: jwt_bearer keys by subject, ignores username", () => {
		const jwt = (over: Partial<OAuth2Config>) =>
			base({ grantType: "jwt_bearer", assertionAudience: "https://idp", ...over });
		expect(computeOAuth2CacheKey(jwt({ subject: "alice" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fjwt_bearer\x1falice"
		);
		expect(computeOAuth2CacheKey(jwt({ subject: "bob" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fjwt_bearer\x1fbob"
		);
		expect(computeOAuth2CacheKey(jwt({ subject: "alice", username: "u1" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fjwt_bearer\x1falice"
		);
		expect(computeOAuth2CacheKey(jwt({}))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fjwt_bearer\x1f"
		);
	});

	it("vector 8: subject is ignored outside jwt_bearer", () => {
		expect(computeOAuth2CacheKey(base({ subject: "alice" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
		expect(
			computeOAuth2CacheKey(base({ grantType: "password", username: "u1", subject: "alice" }))
		).toBe("https://idp/token\x1fcid\x1fdefault\x1fpassword\x1fu1");
	});

	it("vector 9: ASCII whitespace around accessTokenUrl is trimmed, not inside it (#3687)", () => {
		expect(
			computeOAuth2CacheKey(
				base({ accessTokenUrl: " \t\r\n\v\fhttps://idp/to ken\f\v\n\r\t " })
			)
		).toBe("https://idp/to ken\x1fcid\x1fdefault\x1fclient_credentials\x1f");
		expect(computeOAuth2CacheKey(base({ accessTokenUrl: " \t\r\n\v\f" }))).toBe(
			"\x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
	});

	it("vector 10: a no-break space is not ASCII whitespace and stays", () => {
		// String.prototype.trim would strip it and split the key from the engine's.
		expect(computeOAuth2CacheKey(base({ accessTokenUrl: " https://idp/token " }))).toBe(
			" https://idp/token \x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
	});

	it("vector 11: the raw grantType is the fourth segment, so grants are separate keys (#3689)", () => {
		const clientCredentials = computeOAuth2CacheKey(base({}));
		const authorizationCode = computeOAuth2CacheKey(base({ grantType: "authorization_code" }));
		expect(clientCredentials).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f"
		);
		expect(authorizationCode).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fauthorization_code\x1f"
		);
		expect(authorizationCode).not.toBe(clientCredentials);
		// An absent or non-string grantType is an empty segment, as the engine reads it.
		const absent = { grantType: undefined } as unknown as Partial<OAuth2Config>;
		const numeric = { grantType: 7 } as unknown as Partial<OAuth2Config>;
		expect(computeOAuth2CacheKey(base(absent))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1f\x1f"
		);
		expect(computeOAuth2CacheKey(base(numeric))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1f\x1f"
		);
	});
});

describe("computeOAuth2CacheKey - extra parameter rows", () => {
	const keyOf = (tokenParams: OAuth2Config["tokenParams"]) =>
		computeOAuth2CacheKey(base({ tokenParams }));

	it("ignores row order but not a row's value", () => {
		const audience = { key: "audience", value: "api-1" };
		const tenant = { key: "tenant", value: "t" };
		expect(keyOf([audience, tenant])).toBe(keyOf([tenant, audience]));
		expect(keyOf([audience, tenant])).not.toBe(
			keyOf([{ ...audience, value: "api-2" }, tenant])
		);
	});

	// The key is handed to clients and stored as the token row's primary key, so
	// a credential row contributes its name alone (OAuthCacheKey.
	// CredentialRowsAreKeyedByNameAlone). Mutation check: key a credential row by
	// its value in `keyedPair` and the first two expectations fail.
	it("keys a credential row by its name, an ordinary row by its value too", () => {
		const withRows = (assertion: string, audience: string) =>
			keyOf([
				{ key: "client_assertion", value: assertion },
				{ key: "audience", value: audience },
			]);
		const key = withRows("jwt-1", "api");
		expect(key).toBe(withRows("jwt-2", "api"));
		expect(key).not.toContain("jwt-1");
		expect(key).not.toBe(withRows("jwt-1", "other-api"));
	});

	it("keys a config with only disabled rows as one with none", () => {
		expect(keyOf([{ key: "audience", value: "api", enabled: false }])).toBe(keyOf(undefined));
	});

	it("sorts by UTF-8 bytes, not UTF-16 code units", () => {
		// U+FF5E is one UTF-16 unit (0xFF5E) but three UTF-8 bytes (EF BD 9E); U+1F600
		// is a surrogate pair (0xD83D...) but four bytes (F0 9F 98 80). By code unit
		// the emoji sorts first, by byte the full-width tilde does - the engine's way.
		expect(
			keyOf([
				{ key: "\u{1F600}", value: "" },
				{ key: "\uFF5E", value: "" },
			])
		).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f\x1ftokenParams:\uFF5E=\x1e\u{1F600}="
		);
	});

	it("breaks a key tie by value, and a shared prefix by length", () => {
		expect(
			keyOf([
				{ key: "ab", value: "1" },
				{ key: "a", value: "2" },
				{ key: "a", value: "1" },
			])
		).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1fclient_credentials\x1f\x1ftokenParams:a=1\x1ea=2\x1eab=1"
		);
	});
});
