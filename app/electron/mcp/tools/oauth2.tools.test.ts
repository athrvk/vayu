/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, TOOLS } from "../tools.js";
import { OAUTH2_TOKEN_RECORD, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/**
 * The OAuth 2.0 token-cache tools (issue #760).
 *
 * Two rules carry the weight here and both are security-shaped: the interactive
 * grant is refused *before* the engine is called, and no tool ever returns the
 * access token's bytes.
 */
describe("OAuth 2.0 token tools", () => {
	const config = {
		grantType: "client_credentials",
		accessTokenUrl: "https://id.example.com/oauth/token",
		clientId: "client_a",
		clientSecret: "s3cret",
	};
	const allow = { allowlist: ["id.example.com"] };

	test("the three tools sit in the categories their effects call for", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		// It contacts a third party; it does not mutate saved documents.
		expect(tools.get("fetch_oauth2_token")?.category).toBe("execute");
		expect(tools.get("fetch_oauth2_token")?.annotations.openWorldHint).toBe(true);
		expect(tools.get("get_oauth2_token_status")?.category).toBe("read");
		// It destroys a stored credential, so it sits behind the write toggle -
		// the same place `clear_cookies` sits for the same reason.
		expect(tools.get("clear_oauth2_token")?.category).toBe("write");
	});

	test("fetch acquires the token and never hands back the bearer", async () => {
		const client = fakeClient();
		const res = await dispatchTool("fetch_oauth2_token", { config }, ctxWith(client, allow));

		expect(res.isError).toBeFalsy();
		expect(client.fetchOAuth2Token).toHaveBeenCalledTimes(1);
		expect((client.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
			config,
		});
		const text = firstText(res);
		expect(text).not.toContain(OAUTH2_TOKEN_RECORD.accessToken);
		// What an agent legitimately needs from the cache is its shape - the key
		// it can inspect and clear by, and when it expires.
		expect(JSON.parse(text)).toEqual({
			cacheKey: OAUTH2_TOKEN_RECORD.cacheKey,
			tokenType: "Bearer",
			scope: "orders:read",
			expiresIn: 3600,
			createdAt: OAUTH2_TOKEN_RECORD.createdAt,
			expiresAt: OAUTH2_TOKEN_RECORD.expiresAt,
			hasRefreshToken: true,
			// Stated rather than silently omitted: an agent that finds no token
			// and is not told why concludes the acquisition half-failed.
			accessTokenWithheld: true,
		});
	});

	test("force is forwarded only when asked for", async () => {
		const forced = fakeClient();
		await dispatchTool("fetch_oauth2_token", { config, force: true }, ctxWith(forced, allow));
		expect(
			(forced.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]
		).toMatchObject({ force: true });

		const plain = fakeClient();
		await dispatchTool("fetch_oauth2_token", { config, force: false }, ctxWith(plain, allow));
		// A stated `false` is the engine's own default, and sending it would make
		// "the caller said no" indistinguishable from "the caller said nothing".
		expect(
			(plain.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]
		).not.toHaveProperty("force");
	});

	/**
	 * The refusal is not merely "it cannot work". `acquire_token` answers a cache
	 * hit *before* it looks at the grant, so a call naming a config that matches
	 * an entry the user authorized in a browser would otherwise reach into it.
	 */
	test("the authorization_code grant is refused before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"fetch_oauth2_token",
			{ config: { ...config, grantType: "authorization_code" } },
			ctxWith(client, allow)
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/authorization_code/);
		// The refusal names where the user can do it instead.
		expect(firstText(res)).toMatch(/Auth tab|in Vayu/i);
		expect(client.fetchOAuth2Token).not.toHaveBeenCalled();
	});

	// The tool names no scope, so a `{{variable}}` privateKey is the engine's 400;
	// a jwt_bearer config here names its key in `privateKeyFile`. This layer
	// forwards the whole block untouched and keeps the same two gates.
	describe("a jwt_bearer config", () => {
		const jwtConfig = {
			grantType: "jwt_bearer",
			accessTokenUrl: "https://id.example.com/oauth/token",
			clientId: "client_a",
			subject: "svc@example.com",
			assertionAudience: "https://id.example.com/",
			assertionClaims: [{ key: "tenant", value: "t1" }],
			signingAlgorithm: "ES256",
			keyId: "k1",
			privateKeyFile: "/keys/sign.pem",
			fallbackExpiresIn: 300,
		};

		test("reaches the engine whole, privateKeyFile included", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"fetch_oauth2_token",
				{ config: jwtConfig },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			expect((client.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
				config: jwtConfig,
			});
			expect(firstText(res)).not.toContain(OAUTH2_TOKEN_RECORD.accessToken);
		});

		test("is still held to the allowlist on its token endpoint", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"fetch_oauth2_token",
				{ config: jwtConfig },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/accessTokenUrl/);
			expect(client.fetchOAuth2Token).not.toHaveBeenCalled();
		});

		test("does not let authorization_code through on the same shape", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"fetch_oauth2_token",
				{ config: { ...jwtConfig, grantType: "authorization_code" } },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(client.fetchOAuth2Token).not.toHaveBeenCalled();
		});
	});

	test("the token endpoint is gated by the allowlist, and so is a different refresh host", async () => {
		const blocked = fakeClient();
		const off = await dispatchTool("fetch_oauth2_token", { config }, ctxWith(blocked));
		expect(off.isError).toBe(true);
		expect(firstText(off)).toMatch(/accessTokenUrl/);
		expect(blocked.fetchOAuth2Token).not.toHaveBeenCalled();

		// A config whose refresh URL points somewhere else must not walk around
		// the gate the token URL passed.
		const sneaky = fakeClient();
		const res = await dispatchTool(
			"fetch_oauth2_token",
			{ config: { ...config, refreshTokenUrl: "https://elsewhere.example.net/refresh" } },
			ctxWith(sneaky, allow)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/refreshTokenUrl/);
		expect(sneaky.fetchOAuth2Token).not.toHaveBeenCalled();
	});

	test("status reports presence and expiry without the bearer", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"get_oauth2_token_status",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(client.getOAuth2TokenStatus).toHaveBeenCalledWith(
			OAUTH2_TOKEN_RECORD.cacheKey,
			undefined
		);
		const text = firstText(res);
		expect(text).toContain('"found":true');
		expect(text).toContain('"expired":false');
		expect(text).not.toContain(OAUTH2_TOKEN_RECORD.accessToken);
	});

	test("an absent entry is an answer, not an error", async () => {
		const client = fakeClient({
			getOAuth2TokenStatus: vi.fn().mockResolvedValue({ found: false }),
		});
		const res = await dispatchTool(
			"get_oauth2_token_status",
			{ cacheKey: "nothing-here" },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain('"found":false');
	});

	test("clearing is refused while writes are off, and reports what it removed when on", async () => {
		const gated = fakeClient();
		const refused = await dispatchTool(
			"clear_oauth2_token",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(gated)
		);
		expect(refused.isError).toBe(true);
		expect(firstText(refused)).toMatch(/writes are disabled/i);
		expect(gated.clearOAuth2Token).not.toHaveBeenCalled();

		const client = fakeClient();
		const res = await dispatchTool(
			"clear_oauth2_token",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.clearOAuth2Token).toHaveBeenCalledWith(
			OAUTH2_TOKEN_RECORD.cacheKey,
			undefined
		);
		expect(firstText(res)).toContain('"deleted":true');
	});

	test("the cache families the renderer must refetch are declared", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		// Both change what the auth tab's status row shows; a read changes nothing.
		expect(tools.get("fetch_oauth2_token")?.invalidates).toEqual(["oauth"]);
		expect(tools.get("clear_oauth2_token")?.invalidates).toEqual(["oauth"]);
		expect(tools.get("get_oauth2_token_status")?.invalidates).toEqual([]);
	});
});
