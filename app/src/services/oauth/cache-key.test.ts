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

describe("computeOAuth2CacheKey — shared vectors", () => {
	it("vector 1: minimal client_credentials", () => {
		expect(computeOAuth2CacheKey(base({}))).toBe("https://idp/token\x1fcid\x1fdefault\x1f");
	});

	it("vector 2: password grant with credentialsId", () => {
		expect(
			computeOAuth2CacheKey(
				base({ grantType: "password", credentialsId: "work", username: "u1" })
			)
		).toBe("https://idp/token\x1fcid\x1fwork\x1fu1");
	});

	it("vector 3: username ignored outside password grant", () => {
		expect(computeOAuth2CacheKey(base({ username: "u1" }))).toBe(
			"https://idp/token\x1fcid\x1fdefault\x1f"
		);
	});
});
