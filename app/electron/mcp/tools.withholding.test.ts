/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, TOOLS } from "./tools.js";
import type { McpSafetyConfig } from "./config.js";
import { EngineRequestError } from "./engine-client.js";
import { page, fakeClient, ctxWith, firstText, ctxAsking, askedQuestion } from "./tools.testkit.js";
import { REVEAL, ALLOW_API, read, readFull } from "./tools.withholding.testkit.js";

describe("disabled tools", () => {
	test("a disabled tool is rejected by dispatch", async () => {
		const res = await dispatchTool(
			"get_engine_health",
			{},
			ctxWith(fakeClient(), { disabledTools: ["get_engine_health"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/disabled/i);
	});
});

/**
 * What a read hands an agent in place of a secret (#1805). Every case runs
 * twice: on the default config, where the value must not appear anywhere in
 * the answer, and with `revealSecretsToAgents`, where it must arrive untouched.
 * A read that forgot its projection passes the second and fails the first; a
 * projection that ignores the setting fails the second.
 */

describe("secret withholding", () => {
	const ENVIRONMENTS = [
		{
			id: "env_1",
			name: "Staging",
			isActive: true,
			variables: {
				apiKey: { value: "sk-live-123", secret: true, enabled: true },
				baseUrl: { value: "https://staging.test", enabled: true },
				// Only `secret: true` is a secret, the way buildVariableOrigins reads it.
				loose: { value: "not-a-secret", secret: "true", enabled: true },
			},
		},
	];

	test("list_environments withholds a secret value by default", async () => {
		const client = fakeClient({ listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS) });
		const { text, body } = await read("list_environments", client);
		expect(text).not.toContain("sk-live-123");
		expect(body[0].variables.apiKey).toEqual({
			secret: true,
			enabled: true,
			valueWithheld: true,
		});
		expect(body[0].variables.baseUrl.value).toBe("https://staging.test");
		expect(body[0].variables.loose.value).toBe("not-a-secret");
		expect(body[0].isActive).toBe(true);
	});

	test("list_environments returns the secret value with reveal on", async () => {
		const client = fakeClient({ listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS) });
		const { body } = await read("list_environments", client, REVEAL);
		expect(body).toEqual(ENVIRONMENTS);
	});

	test("get_globals withholds a secret value unless revealed", async () => {
		const globals = {
			id: "globals",
			variables: { token: { value: "g-secret", secret: true, enabled: true } },
		};
		const client = fakeClient({ getGlobals: vi.fn().mockResolvedValue(globals) });
		const withheld = await read("get_globals", client);
		expect(withheld.text).not.toContain("g-secret");
		expect(withheld.body.variables.token.valueWithheld).toBe(true);
		expect((await read("get_globals", client, REVEAL)).body).toEqual(globals);
	});

	const REQUESTS = [
		{
			id: "req_1",
			name: "Me",
			auth: { mode: "bearer", token: "eyJ.live.token" },
		},
		{
			id: "req_2",
			name: "Referenced",
			auth: { mode: "bearer", token: "{{apiToken}}" },
		},
		{
			id: "req_3",
			name: "Machine",
			auth: {
				mode: "oauth2",
				config: {
					grantType: "client_credentials",
					accessTokenUrl: "https://auth.test/token",
					clientId: "app",
					clientSecret: "cs-123",
				},
			},
		},
		{
			id: "req_4",
			name: "Key",
			auth: { mode: "apikey", key: "X-Api-Key", value: "k-456", in: "header" },
		},
	];

	test("list_requests withholds auth credentials and keeps what describes them", async () => {
		const client = fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) });
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["eyJ.live.token", "cs-123", "k-456"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth).toEqual({ mode: "bearer", tokenWithheld: true });
		// A reference names where the secret lives without being it.
		expect(body[1].auth).toEqual({ mode: "bearer", token: "{{apiToken}}" });
		expect(body[2].auth.config).toEqual({
			grantType: "client_credentials",
			accessTokenUrl: "https://auth.test/token",
			clientId: "app",
			clientSecretWithheld: true,
		});
		expect(body[3].auth).toEqual({
			mode: "apikey",
			key: "X-Api-Key",
			valueWithheld: true,
			in: "header",
		});
	});

	test("a workspace-wide list_requests withholds credentials in every collection's rows", async () => {
		const rows = [
			{ ...REQUESTS[3], collectionId: "c1" },
			{
				id: "req_5",
				collectionId: "c2",
				name: "Typed header",
				auth: { mode: "none" },
				headers: [
					{ key: "Authorization", value: "Bearer typed-live-token", enabled: true },
				],
			},
		];
		const listRequestsPage = vi.fn().mockResolvedValue(page(rows));
		const { text, body } = await readFull("list_requests", fakeClient({ listRequestsPage }));
		expect(listRequestsPage.mock.calls[0][0]).toBeUndefined();
		for (const secret of ["k-456", "typed-live-token"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.map((row: { collectionId: string }) => row.collectionId)).toEqual(["c1", "c2"]);
		expect(body[0].auth).toEqual({
			mode: "apikey",
			key: "X-Api-Key",
			valueWithheld: true,
			in: "header",
		});
		expect(body[1].headers).toEqual([
			{ key: "Authorization", enabled: true, valueWithheld: true },
		]);
	});

	test("list_requests returns auth whole with reveal on", async () => {
		const client = fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) });
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(REQUESTS);
	});

	test("get_request withholds one row's credentials exactly as list_requests does", async () => {
		const client = fakeClient({
			getRequest: vi.fn(async (id: string) => REQUESTS.find((row) => row.id === id)),
		});
		const { text, body } = await read("get_request", client, undefined, { requestId: "req_3" });
		expect(text).not.toContain("cs-123");
		expect(body.auth.config.clientSecretWithheld).toBe(true);
		expect(client.getRequest).toHaveBeenCalledWith("req_3", undefined);

		const listed = await readFull(
			"list_requests",
			fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) }),
			undefined,
			{ collectionId: "c1" }
		);
		expect(body).toEqual(listed.body[2]);
	});

	test("get_request returns the row as stored with reveal on", async () => {
		const client = fakeClient({ getRequest: vi.fn().mockResolvedValue(REQUESTS[0]) });
		const { body } = await read("get_request", client, REVEAL, { requestId: "req_1" });
		expect(body).toEqual(REQUESTS[0]);
	});

	// A jwt_bearer key is a credential like `clientSecret`: only a lone
	// `{{variable}}` is shown (it names where the key lives without being it), a
	// PEM typed into the config is withheld, and the file's path is not a secret.
	describe("a jwt_bearer config read", () => {
		const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----";
		const jwtRow = (key: Record<string, unknown>) => ({
			id: "req_jwt",
			name: "Assertion",
			auth: {
				mode: "oauth2",
				config: {
					grantType: "jwt_bearer",
					accessTokenUrl: "https://auth.test/token",
					clientId: "app",
					subject: "svc@example.com",
					assertionAudience: "https://auth.test/",
					signingAlgorithm: "RS256",
					...key,
				},
			},
		});
		const readJwt = (key: Record<string, unknown>) =>
			read(
				"get_request",
				fakeClient({ getRequest: vi.fn().mockResolvedValue(jwtRow(key)) }),
				undefined,
				{ requestId: "req_jwt" }
			);

		test("shows a privateKey that is one variable reference", async () => {
			const { body } = await readJwt({ privateKey: "{{signingKey}}" });
			expect(body.auth.config.privateKey).toBe("{{signingKey}}");
			expect(body.auth.config).not.toHaveProperty("privateKeyWithheld");
		});

		test("withholds a privateKey that holds the key itself", async () => {
			const { text, body } = await readJwt({ privateKey: PEM });
			expect(text).not.toContain("MIIEvQ");
			expect(body.auth.config.privateKeyWithheld).toBe(true);
			expect(body.auth.config).not.toHaveProperty("privateKey");
		});

		test("withholds a reference with text around it, which is not one", async () => {
			const { text, body } = await readJwt({ privateKey: "{{signingKey}}\n" + PEM });
			expect(text).not.toContain("MIIEvQ");
			expect(body.auth.config.privateKeyWithheld).toBe(true);
		});

		test("shows a privateKeyFile path and the claims beside it", async () => {
			const { body } = await readJwt({ privateKeyFile: "/keys/sign.pem" });
			expect(body.auth.config.privateKeyFile).toBe("/keys/sign.pem");
			expect(body.auth.config.subject).toBe("svc@example.com");
			expect(body.auth.config.signingAlgorithm).toBe("RS256");
		});
	});

	test("get_request answers an unknown id as an error naming the id", async () => {
		const client = fakeClient({
			getRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Request not found")
				),
		});
		const res = await dispatchTool("get_request", { requestId: "req_gone" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No request with id "req_gone"');
	});

	test.each([{}, { requestId: "" }])(
		"get_request refuses %j before the engine is called",
		async (args) => {
			const client = fakeClient();
			const res = await dispatchTool("get_request", args, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/requestId.*required/i);
			expect(client.getRequest).not.toHaveBeenCalled();
		}
	);

	test("get_request is a read tool carrying read-only annotations", () => {
		const tool = TOOLS.find((t) => t.name === "get_request");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	test("list_collections withholds a collection's secret variables and auth", async () => {
		const collections = [
			{
				id: "c1",
				name: "API",
				variables: { pass: { value: "p@ss", secret: true } },
				auth: { mode: "basic", username: "me", password: "hunter2" },
			},
		];
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page(collections)),
		});
		const withheld = await readFull("list_collections", client);
		expect(withheld.text).not.toContain("p@ss");
		expect(withheld.text).not.toContain("hunter2");
		expect(withheld.body[0].auth).toEqual({
			mode: "basic",
			username: "me",
			passwordWithheld: true,
		});
		const revealed = await readFull("list_collections", client, REVEAL);
		expect(revealed.body[0].auth.password).toBe("hunter2");
		expect(revealed.body[0].variables.pass.value).toBe("p@ss");
	});

	const COOKIES = [
		{
			environmentId: null,
			name: "session",
			value: "abc123",
			domain: "x.test",
			path: "/",
			secure: true,
			httpOnly: true,
			expires: 1_900_000_000,
		},
	];

	test("get_cookies withholds every cookie value in full rows unless revealed", async () => {
		const client = fakeClient({ getCookiesPage: vi.fn().mockResolvedValue(page(COOKIES)) });
		const withheld = await readFull("get_cookies", client);
		expect(withheld.text).not.toContain("abc123");
		const { value: _value, ...described } = COOKIES[0];
		expect(withheld.body[0]).toEqual({ ...described, valueWithheld: true });
		expect((await readFull("get_cookies", client, REVEAL)).body).toEqual(COOKIES);
	});

	test.each([{}, REVEAL])(
		"a get_cookies summary row never carries a value (%j)",
		async (safety) => {
			const client = fakeClient({ getCookiesPage: vi.fn().mockResolvedValue(page(COOKIES)) });
			const { text, body } = await read("get_cookies", client, safety);
			expect(text).not.toContain("abc123");
			expect(body.data).toEqual([
				{
					environmentId: null,
					name: "session",
					domain: "x.test",
					path: "/",
					expires: 1_900_000_000,
				},
			]);
		}
	);

	const CONFIG = {
		entries: [
			{ key: "proxyMode", value: "manual" },
			{ key: "proxyUrl", value: "http://alice:pa@ss/w0rd@proxy.corp:8080" },
			{ key: "proxySystemUrl", value: "socks5h://bob:pw@sys.proxy:1080" },
			{ key: "proxyBypass", value: ".internal.test" },
			{ key: "workers", value: "8" },
		],
	};

	test("get_engine_config strips proxy URL credentials and keeps the host", async () => {
		const client = fakeClient({ getConfig: vi.fn().mockResolvedValue(CONFIG) });
		const { text, body } = await read("get_engine_config", client);
		for (const secret of ["alice", "pa@ss", "w0rd", "bob", ":pw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.entries[1]).toEqual({
			key: "proxyUrl",
			value: "http://proxy.corp:8080",
			credentialsWithheld: true,
		});
		expect(body.entries[2].value).toBe("socks5h://sys.proxy:1080");
		expect(body.entries[0]).toEqual(CONFIG.entries[0]);
		expect(body.entries[3]).toEqual(CONFIG.entries[3]);
		expect(body.entries[4]).toEqual(CONFIG.entries[4]);
	});

	test("get_engine_config returns proxy credentials with reveal on", async () => {
		const client = fakeClient({ getConfig: vi.fn().mockResolvedValue(CONFIG) });
		expect((await read("get_engine_config", client, REVEAL)).body).toEqual(CONFIG);
	});

	const DIAGNOSIS = {
		url: "https://api.example.com/",
		outcome: "proxy_failed",
		errorCode: "PROXY_ERROR",
		proxy: { mode: "manual", url: "http://alice:pa@ss/w0rd@proxy.corp:8080" },
		clientCertificate: "",
	};

	test("diagnose_connection strips the proxy URL's credentials and keeps the host", async () => {
		const client = fakeClient({ diagnoseConnection: vi.fn().mockResolvedValue(DIAGNOSIS) });
		const { text, body } = await read("diagnose_connection", client, ALLOW_API, {
			url: "https://api.example.com/",
		});
		for (const secret of ["alice", "pa@ss", "w0rd"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.proxy).toEqual({
			mode: "manual",
			url: "http://proxy.corp:8080",
			credentialsWithheld: true,
		});
		expect(body.outcome).toBe("proxy_failed");
	});

	test("diagnose_connection strips the credentials with reveal on too, as the backstop", async () => {
		// The engine strips a proxy URL's userinfo before it answers (#3258), so
		// the fixture above is a regression, not a real answer. Reveal is for
		// stored secrets and cannot lift a withholding the engine never made.
		const client = fakeClient({ diagnoseConnection: vi.fn().mockResolvedValue(DIAGNOSIS) });
		const { text, body } = await read(
			"diagnose_connection",
			client,
			{ ...ALLOW_API, ...REVEAL },
			{ url: "https://api.example.com/" }
		);
		for (const secret of ["alice", "pa@ss", "w0rd"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.proxy.url).toBe("http://proxy.corp:8080");
	});

	test("diagnose_connection passes the engine's own answer through untouched", async () => {
		const answer = {
			...DIAGNOSIS,
			proxy: { mode: "system", source: "environment", url: "http://proxy.corp:8080" },
		};
		const client = fakeClient({ diagnoseConnection: vi.fn().mockResolvedValue(answer) });
		const { body } = await read("diagnose_connection", client, ALLOW_API, {
			url: "https://api.example.com/",
		});
		expect(body).toEqual(answer);
	});

	test("update_engine_config's echo of the config table withholds the same credentials", async () => {
		const client = fakeClient({
			updateConfig: vi.fn().mockResolvedValue({ ...CONFIG, success: true }),
		});
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "8" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(JSON.stringify(res)).not.toContain("alice");
		const out = res.structuredContent as { updated: typeof CONFIG };
		expect(out.updated.entries[1].value).toBe("http://proxy.corp:8080");
	});

	test("resolve_variables reports a secret's value with reveal on", async () => {
		const client = fakeClient({
			getGlobals: vi.fn().mockResolvedValue({
				variables: { token: { value: "s3cret", enabled: true, secret: true } },
			}),
		});
		const { body } = await read("resolve_variables", client, REVEAL);
		const token = body.variables.find((v: { name: string }) => v.name === "token");
		expect(token.value).toBe("s3cret");
		expect(token).not.toHaveProperty("valueWithheld");
	});

	test("an auth block read with its credentials withheld is refused as an argument", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", auth: { mode: "bearer", tokenWithheld: true } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("tokenWithheld");
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("so is one whose withheld credential sat under config", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{ name: "API", auth: { mode: "oauth2", config: { clientSecretWithheld: true } } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("clientSecretWithheld");
		expect(client.createCollection).not.toHaveBeenCalled();
	});

	// A Postman import keeps the auth as Postman wrote it under `postman`, raw
	// credentials included: the engine's `redact_postman_auth` is the rule.
	const POSTMAN_REQUESTS = [
		{
			id: "req_pm1",
			name: "Imported bearer",
			auth: {
				mode: "bearer",
				token: "{{tok}}",
				postman: {
					type: "bearer",
					bearer: [{ key: "token", value: "pm-bearer-raw", type: "string" }],
				},
			},
		},
		{
			id: "req_pm2",
			name: "Imported OAuth 2.0",
			auth: {
				mode: "oauth2",
				config: { grantType: "client_credentials", clientId: "app" },
				postman: {
					type: "oauth2",
					oauth2: [
						{ key: "clientSecret", value: "pm-cs-raw", type: "string" },
						{ key: "clientId", value: "app", type: "string" },
						{ key: "accessToken", value: "{{seeded}}", type: "string" },
						{
							key: "tokenRequestParams",
							value: [
								{ key: "client_secret", value: "pm-param-raw", enabled: true },
								{ key: "audience", value: "api", enabled: true },
							],
							type: "any",
						},
					],
				},
			},
		},
	];

	test("list_requests withholds the credentials in a Postman import's source", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(POSTMAN_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["pm-bearer-raw", "pm-cs-raw", "pm-param-raw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.postman.bearer).toEqual([
			{ key: "token", type: "string", valueWithheld: true },
		]);
		expect(body[1].auth.postman.oauth2).toEqual([
			{ key: "clientSecret", type: "string", valueWithheld: true },
			{ key: "clientId", value: "app", type: "string" },
			{ key: "accessToken", value: "{{seeded}}", type: "string" },
			{
				key: "tokenRequestParams",
				value: [
					{ key: "client_secret", enabled: true, valueWithheld: true },
					{ key: "audience", value: "api", enabled: true },
				],
				type: "any",
			},
		]);
	});

	test("list_requests returns a Postman import's source whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(POSTMAN_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(POSTMAN_REQUESTS);
	});

	test("list_collections withholds a v2.0 Postman source's credentials unless revealed", async () => {
		const collections = [
			{
				id: "c1",
				name: "API",
				auth: {
					mode: "oauth2",
					config: { grantType: "client_credentials", clientId: "app" },
					postman: {
						type: "oauth2",
						oauth2: {
							clientId: "app",
							clientSecret: "pm-v20-raw",
							refreshRequestParams: [{ key: "refresh_token", value: "pm-rt-raw" }],
						},
					},
				},
			},
		];
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page(collections)),
		});
		const withheld = await readFull("list_collections", client);
		expect(withheld.text).not.toContain("pm-v20-raw");
		expect(withheld.text).not.toContain("pm-rt-raw");
		expect(withheld.body[0].auth.postman).toEqual({
			type: "oauth2",
			oauth2: {
				clientId: "app",
				clientSecretWithheld: true,
				refreshRequestParams: [{ key: "refresh_token", valueWithheld: true }],
			},
		});
		const revealed = await readFull("list_collections", client, REVEAL);
		expect(revealed.body[0].auth.postman).toEqual(collections[0].auth.postman);
	});

	test("an auth argument whose Postman source was read withheld is refused", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_pm2",
				auth: {
					mode: "oauth2",
					postman: {
						type: "oauth2",
						oauth2: [
							{
								key: "tokenRequestParams",
								value: [{ key: "client_secret", valueWithheld: true }],
							},
						],
					},
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(
			"postman.oauth2[tokenRequestParams][client_secret].valueWithheld"
		);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("so is one whose v2.0 Postman source carries a withheld member", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{
				name: "API",
				auth: {
					mode: "bearer",
					postman: { type: "bearer", bearer: { tokenWithheld: true } },
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("postman.bearer.tokenWithheld");
		expect(client.createCollection).not.toHaveBeenCalled();
	});

	// An OAuth 2.0 config's extra request parameter lists (#2536): redacted per
	// row, so the key, `enabled` and `sendAs` stay and only a credential's value
	// goes. A row can be sent as a header, so the header names count too.
	const CONFIG_PARAM_REQUEST = {
		id: "req_cfg",
		name: "OAuth 2.0 with extra parameters",
		auth: {
			mode: "oauth2",
			config: {
				grantType: "authorization_code",
				clientId: "app",
				authorizationParams: [
					{ key: "api_key", value: "cfg-q-raw", enabled: true },
					{ key: "prompt", value: "login", enabled: true },
				],
				tokenParams: [
					{ key: "client_secret", value: "cfg-body-raw", enabled: true, sendAs: "body" },
					{
						key: "Authorization",
						value: "cfg-hdr-raw",
						enabled: false,
						sendAs: "header",
					},
					{ key: "audience", value: "api", enabled: true, sendAs: "url" },
				],
				refreshParams: [
					{ key: "refresh_token", value: "{{rt}}", enabled: true },
					{ key: "assertion", value: "cfg-assert-raw", enabled: true },
				],
			},
		},
	};

	test("list_requests withholds a credential-named extra parameter's value, row by row", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page([CONFIG_PARAM_REQUEST])),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["cfg-q-raw", "cfg-body-raw", "cfg-hdr-raw", "cfg-assert-raw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.config).toEqual({
			grantType: "authorization_code",
			clientId: "app",
			authorizationParams: [
				{ key: "api_key", enabled: true, valueWithheld: true },
				{ key: "prompt", value: "login", enabled: true },
			],
			tokenParams: [
				{ key: "client_secret", enabled: true, sendAs: "body", valueWithheld: true },
				{ key: "Authorization", enabled: false, sendAs: "header", valueWithheld: true },
				{ key: "audience", value: "api", enabled: true, sendAs: "url" },
			],
			refreshParams: [
				{ key: "refresh_token", value: "{{rt}}", enabled: true },
				{ key: "assertion", enabled: true, valueWithheld: true },
			],
		});
	});

	test("list_requests returns the extra parameter rows whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page([CONFIG_PARAM_REQUEST])),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual([CONFIG_PARAM_REQUEST]);
	});

	test("an auth argument whose extra parameter row was read withheld is refused", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_cfg",
				auth: {
					mode: "oauth2",
					config: {
						tokenParams: [{ key: "client_secret", enabled: true, valueWithheld: true }],
					},
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("config.tokenParams[client_secret].valueWithheld");
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	// A row the engine's export would blank whole - no key, or a member no row
	// has - is withheld here too, not passed through because its key names no
	// credential. Mutation check: withhold only a credential-named row's
	// `value` and the secrets below reach the agent.
	test("list_requests withholds an extra parameter row with no key, or a member no row has", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(
				page([
					{
						id: "req_odd",
						auth: {
							mode: "oauth2",
							config: {
								tokenParams: [
									{ value: "odd-keyless-raw" },
									{ keyy: "client_secret", value: "odd-misspelt-raw" },
									{ key: "audience", value: "api", note: "odd-note-raw" },
								],
								refreshParams: "refresh_token=odd-list-raw",
							},
						},
					},
				])
			),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"odd-keyless-raw",
			"odd-misspelt-raw",
			"odd-note-raw",
			"odd-list-raw",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.config).toEqual({
			tokenParams: [
				{ valueWithheld: true },
				{ valueWithheld: true },
				{ key: "audience", value: "api", noteWithheld: true },
			],
			refreshParamsWithheld: true,
		});
	});

	test.each([
		[
			"a keyless row",
			{ tokenParams: [{ valueWithheld: true }] },
			"config.tokenParams[0].valueWithheld",
		],
		[
			"a row's other member",
			{ tokenParams: [{ key: "audience", value: "api", noteWithheld: true }] },
			"config.tokenParams[audience].noteWithheld",
		],
		["a whole list", { refreshParamsWithheld: true }, "config.refreshParamsWithheld"],
	])("an auth argument carrying %s read withheld is refused", async (_, config, marker) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_cfg", auth: { mode: "oauth2", config } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(marker);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	// A header typed straight into the Headers tab is no variable: its name is
	// the only signal, and the shared list plus the request's API-key header
	// decide (#1809).
	const HEADER_REQUESTS = [
		{
			id: "req_h1",
			name: "Typed credentials",
			auth: { mode: "none" },
			headers: [
				{ key: "Authorization", value: "Bearer typed-live-token", enabled: true },
				{ key: "cookie", value: "sid=typed-cookie", enabled: false },
				{ key: "X-Api-Key", value: "{{apiKey}}", enabled: true },
				{ key: "X-Auth-Token", value: "", enabled: true },
				{ key: "Content-Type", value: "application/json", enabled: true },
			],
		},
		{
			id: "req_h2",
			name: "API-key auth names its header",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "header" },
			headers: [{ key: "x-tenant-key", value: "typed-tenant-key", enabled: true }],
		},
		{
			id: "req_h3",
			name: "API-key auth in the query",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "query" },
			headers: [{ key: "X-Tenant-Key", value: "typed-query-tenant", enabled: true }],
		},
	];

	test("list_requests withholds a credential-bearing header's value and keeps the row", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(HEADER_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"typed-live-token",
			"typed-cookie",
			"typed-tenant-key",
			"typed-query-tenant",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].headers).toEqual([
			{ key: "Authorization", enabled: true, valueWithheld: true },
			{ key: "cookie", enabled: false, valueWithheld: true },
			// A reference names where the secret lives without being it, and an
			// empty value holds none.
			{ key: "X-Api-Key", value: "{{apiKey}}", enabled: true },
			{ key: "X-Auth-Token", value: "", enabled: true },
			{ key: "Content-Type", value: "application/json", enabled: true },
		]);
		expect(body[1].headers).toEqual([
			{ key: "x-tenant-key", enabled: true, valueWithheld: true },
		]);
		// The engine names the API-key header whatever `in` says, so a header row
		// under that name is withheld beside a query-placed key too.
		expect(body[2].headers).toEqual([
			{ key: "X-Tenant-Key", enabled: true, valueWithheld: true },
		]);
	});

	test("list_requests returns every header whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(HEADER_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(HEADER_REQUESTS);
	});

	// A credential written into the URL or the Params table is no variable
	// either: the name decides, in the URL as in the rows (#1837).
	const URL_REQUESTS = [
		{
			id: "req_u1",
			name: "Credentials in the URL",
			auth: { mode: "none" },
			url: "https://typed-user:typed-password@api.example.com/x?api_key=typed-api-key&page=2&token={{token}}#access_token=typed-fragment-token",
			params: [
				{ key: "api_key", value: "typed-api-key", enabled: true },
				{ key: "page", value: "2", enabled: true },
				{ key: "TOKEN", value: "typed-disabled-token", enabled: false },
				{ key: "signature", value: "{{signature}}", enabled: true },
				{ key: "code", value: "US", enabled: true },
			],
		},
		{
			id: "req_u2",
			name: "API-key auth in the query",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "query" },
			url: "https://api.example.com/x?x-tenant-key=typed-tenant-key&code=US",
			params: [{ key: "x-tenant-KEY", value: "typed-tenant-key", enabled: true }],
		},
		{
			id: "req_u3",
			name: "API-key auth in a header does not name a query parameter",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "header" },
			url: "https://api.example.com/x?x-tenant-key=kept",
			params: [{ key: "x-tenant-key", value: "kept", enabled: true }],
		},
		{ id: "req_u4", name: "Not a string", auth: { mode: "none" }, url: null, params: "none" },
	];

	test("list_requests drops a URL's password and credential query values and withholds the Params rows", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(URL_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"typed-password",
			"typed-api-key",
			"typed-fragment-token",
			"typed-disabled-token",
			"typed-tenant-key",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].url).toBe(
			"https://typed-user@api.example.com/x?api_key=&page=2&token={{token}}#access_token="
		);
		expect(body[0].params).toEqual([
			{ key: "api_key", enabled: true, valueWithheld: true },
			{ key: "page", value: "2", enabled: true },
			{ key: "TOKEN", enabled: false, valueWithheld: true },
			{ key: "signature", value: "{{signature}}", enabled: true },
			{ key: "code", value: "US", enabled: true },
		]);
		expect(body[1].url).toBe("https://api.example.com/x?x-tenant-key=&code=US");
		expect(body[1].params).toEqual([
			{ key: "x-tenant-KEY", enabled: true, valueWithheld: true },
		]);
		expect(body[2].url).toBe(URL_REQUESTS[2].url);
		expect(body[2].params).toEqual(URL_REQUESTS[2].params);
		expect(body[3]).toEqual(URL_REQUESTS[3]);
	});

	test("list_requests returns every URL and Params row whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(URL_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(URL_REQUESTS);
	});

	// The preview is read by the agent and the prompt by a person, and the URL
	// is in both.
	const deletePreview = async (safety: Partial<McpSafetyConfig>) => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue({
				id: "req_1",
				name: "Get users",
				method: "GET",
				url: "https://typed-user:typed-password@api.example.com/users?api_key=typed-api-key&page=2",
				auth: { mode: "none" },
			}),
		});
		const unprompted = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true, ...safety })
		);
		const asked = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxAsking(client, { allowWrites: true, ...safety })
		);
		return { preview: firstText(unprompted), prompt: askedQuestion(asked) };
	};

	test("delete_request names the URL in its preview and prompt without the password or the credential values", async () => {
		const { preview, prompt } = await deletePreview({});
		for (const text of [preview, prompt]) {
			expect(text).toContain("GET https://typed-user@api.example.com/users?api_key=&page=2");
			expect(text).not.toContain("typed-password");
			expect(text).not.toContain("typed-api-key");
		}
	});

	test("delete_request names the URL as stored with reveal on", async () => {
		const { preview, prompt } = await deletePreview(REVEAL);
		for (const text of [preview, prompt]) {
			expect(text).toContain(
				"https://typed-user:typed-password@api.example.com/users?api_key=typed-api-key&page=2"
			);
		}
	});
});
