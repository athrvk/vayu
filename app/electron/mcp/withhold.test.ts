/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file withhold.test.ts
 * @brief The shapes `withholdDiagnoseCredentials` leaves alone (#1805): an
 *        answer with nothing to strip is returned as it came; the header rows
 *        `withholdRowSecrets` masks and the lists `withholdReorderRows` walks;
 *        and the run-output mask: its forms, its header rule and how it reads
 *        the workspace (#1809).
 */

import { describe, expect, test, vi } from "vitest";
import { resolveSafetyConfig } from "./config.js";
import {
	MaskingIncompleteError,
	REDACTED_MARKER,
	runOutputShape,
	secretForms,
	withholdDiagnoseCredentials,
	withholdReorderRows,
	withholdRowSecrets,
	withholdRunOutput,
	type RunOutputRule,
} from "./withhold.js";

describe("withholdDiagnoseCredentials", () => {
	test("strips userinfo from proxy.url and marks the proxy node", () => {
		const answer = {
			outcome: "ok",
			proxy: { mode: "manual", url: "socks5h://bob:pw@sys.proxy:1080" },
		};
		expect(withholdDiagnoseCredentials(answer)).toEqual({
			outcome: "ok",
			proxy: { mode: "manual", url: "socks5h://sys.proxy:1080", credentialsWithheld: true },
		});
		expect(answer.proxy.url).toBe("socks5h://bob:pw@sys.proxy:1080");
	});

	test.each([
		["no proxy node", { outcome: "ok" }],
		["a proxy node that is not an object", { outcome: "ok", proxy: "manual" }],
		["no proxy.url", { outcome: "ok", proxy: { mode: "environment" } }],
		["a non-string proxy.url", { outcome: "ok", proxy: { mode: "manual", url: 8080 } }],
		[
			"a proxy.url with no credentials",
			{ outcome: "ok", proxy: { mode: "manual", url: "http://proxy.corp:8080" } },
		],
		["a non-object answer", "proxy_failed"],
		["a null answer", null],
	])("passes %s through untouched", (_name, answer) => {
		expect(withholdDiagnoseCredentials(answer)).toBe(answer);
	});
});

describe("withholdRowSecrets headers", () => {
	const row = (headers: unknown, auth?: unknown) => ({
		id: "r",
		headers,
		...(auth === undefined ? {} : { auth }),
	});

	test("an API-key header is matched by the auth's key, ignoring case and padding", () => {
		const out = withholdRowSecrets(
			row([{ key: " X-Tenant-Key ", value: "k", enabled: true }], {
				mode: "apikey",
				key: "x-TENANT-key",
			})
		);
		expect(out).toEqual(
			row([{ key: " X-Tenant-Key ", enabled: true, valueWithheld: true }], {
				mode: "apikey",
				key: "x-TENANT-key",
			})
		);
	});

	test("a query-placed key still names its header, as the engine's rule does", () => {
		const auth = { mode: "apikey", key: "X-Tenant-Key", in: "query" };
		expect(
			withholdRowSecrets(row([{ key: "X-Tenant-Key", value: "k", enabled: true }], auth))
		).toEqual(row([{ key: "X-Tenant-Key", enabled: true, valueWithheld: true }], auth));
	});

	test.each([
		["another auth mode", { mode: "bearer", key: "X-Tenant-Key" }],
		["a non-string key", { mode: "apikey", key: 7 }],
		["no auth", undefined],
	])("a custom header stays readable under %s", (_name, auth) => {
		const headers = [{ key: "X-Tenant-Key", value: "k", enabled: true }];
		expect(withholdRowSecrets(row(headers, auth))).toEqual(row(headers, auth));
	});

	test.each([
		["a header map", { Authorization: "Bearer x" }],
		["no list", null],
	])("%s passes through untouched", (_name, headers) => {
		expect(withholdRowSecrets(row(headers))).toEqual(row(headers));
	});

	test("a malformed row, or a nameless one, is left as it came", () => {
		const headers = [
			"Authorization: Bearer x",
			{ value: "Bearer x" },
			{ key: "", value: "Bearer x" },
			{ key: "Authorization", value: 5 },
		];
		expect(withholdRowSecrets(row(headers))).toEqual(row(headers));
	});
});

describe("withholdReorderRows", () => {
	const auth = { mode: "bearer", token: "t0k" };

	test("withholds both row lists and keeps the rest of the answer", () => {
		expect(
			withholdReorderRows({
				collections: [{ id: "c", auth }],
				requests: [{ id: "r", auth }],
				n: 2,
			})
		).toEqual({
			collections: [{ id: "c", auth: { mode: "bearer", tokenWithheld: true } }],
			requests: [{ id: "r", auth: { mode: "bearer", tokenWithheld: true } }],
			n: 2,
		});
	});

	test.each([
		[
			"a missing list",
			{ requests: [{ id: "r", auth }] },
			{ requests: [{ id: "r", auth: { mode: "bearer", tokenWithheld: true } }] },
		],
		["a list that is not one", { collections: "none" }, { collections: "none" }],
		["a non-object answer", "ok", "ok"],
	])("passes %s through", (_name, answer, expected) => {
		expect(withholdReorderRows(answer)).toEqual(expected);
	});
});

describe("secretForms", () => {
	test("holds each form the engine's snapshot masker knows", () => {
		expect(new Set(secretForms(['p@ss "w/rd"&<x>']))).toEqual(
			new Set([
				'p@ss "w/rd"&<x>',
				// `url_encode`: everything outside RFC 3986's unreserved set.
				"p%40ss%20%22w%2Frd%22%26%3Cx%3E",
				// `encode_query_component`, a value: Postman's set, `@` and `/` raw.
				"p@ss%20%22w/rd%22%26%3Cx%3E",
				'p@ss \\"w/rd\\"&<x>',
				'p@ss "w/rd"&amp;&lt;x&gt;',
				"p@ss &quot;w/rd&quot;&amp;&lt;x&gt;",
			])
		);
	});

	test("escapes control characters the way a JSON string holds them", () => {
		expect(secretForms(["a\tb\u0001c"])).toContain("a\\tb\\u0001c");
	});

	test("percent-encodes each UTF-8 byte", () => {
		expect(secretForms(["ünï"])).toContain("%C3%BCn%C3%AF");
	});

	test("keeps a whole {{token}} as written in the query form", () => {
		expect(secretForms(["a b{{c d}}"])).toContain("a%20b{{c d}}");
	});

	test("skips a value under four bytes, counting bytes rather than characters", () => {
		expect(secretForms(["abc", ""])).toEqual([]);
		// Two characters, four UTF-8 bytes: long enough.
		expect(secretForms(["üü"])).toContain("üü");
	});

	test("orders the forms longest first, so a secret holding another is masked whole", () => {
		const forms = secretForms(["abcd", "xxabcdxx"]);
		expect(forms.indexOf("xxabcdxx")).toBeLessThan(forms.indexOf("abcd"));
		const rule: RunOutputRule = { forms, apiKeyHeaders: [] };
		expect(withholdRunOutput("k=xxabcdxx", rule)).toBe(`k=${REDACTED_MARKER}`);
	});
});

describe("withholdRunOutput", () => {
	const rule: RunOutputRule = {
		forms: secretForms(["s3cret-value"]),
		apiKeyHeaders: ["x-tenant"],
	};

	test("masks every occurrence in every string, and leaves keys and numbers alone", () => {
		const record = {
			"s3cret-value": "s3cret-value and s3cret-value",
			bodyBytes: 42,
			nested: [{ deep: "a=s3cret-value" }, true, null],
		};
		expect(withholdRunOutput(record, rule)).toEqual({
			"s3cret-value": "<redacted> and <redacted>",
			bodyBytes: 42,
			nested: [{ deep: "a=<redacted>" }, true, null],
		});
	});

	test("leaves a lone {{variable}} as written, in a value and in a credential header", () => {
		const trace = {
			url: "https://x.test/?k={{apiKey}}",
			headers: { Authorization: "{{token}}", Cookie: "" },
		};
		expect(withholdRunOutput(trace, rule)).toEqual(trace);
	});

	test("masks a credential line of a wire frame's header block and nothing else", () => {
		const frame =
			"GET /x HTTP/1.1\r\nHost: x.test\r\nauthorization:Basic dXNlcg==\r\n" +
			"X-Tenant:  t-1\r\nCookie: a=1; b=2\r\nAccept: */*\r\n\r\n" +
			"Cookie: in-the-body";
		expect(withholdRunOutput({ rawRequest: frame }, rule)).toEqual({
			rawRequest:
				"GET /x HTTP/1.1\r\nHost: x.test\r\nauthorization:<redacted>\r\n" +
				"X-Tenant:  <redacted>\r\nCookie: <redacted>\r\nAccept: */*\r\n\r\n" +
				"Cookie: in-the-body",
		});
	});

	test("reads a frame with no body as all header block", () => {
		expect(withholdRunOutput({ rawRequest: "GET / HTTP/1.1\r\nCookie: a=1" }, rule)).toEqual({
			rawRequest: "GET / HTTP/1.1\r\nCookie: <redacted>",
		});
	});

	test("masks a response's Set-Cookie in a header map, keeping every name and the order", () => {
		const response = {
			headers: {
				"content-type": "text/html",
				"set-cookie": "sid=1, theme=dark",
				etag: "w/1",
			},
		};
		const out = withholdRunOutput(response, rule) as typeof response;
		expect(out).toEqual({
			headers: { "content-type": "text/html", "set-cookie": "<redacted>", etag: "w/1" },
		});
		expect(Object.keys(out.headers)).toEqual(Object.keys(response.headers));
	});

	test("masks credential header rows and a sent-header map, by the shared list and the API-key name", () => {
		const node = {
			headers: [
				{ key: "X-Api-Key", value: "k", enabled: true },
				{ key: "X-Other", value: "v", enabled: true },
			],
			sentHeaders: { "X-TENANT": "t", "Proxy-Authorization": "Basic p" },
			requestHeaders: { Accept: "*/*" },
		};
		expect(withholdRunOutput(node, rule)).toEqual({
			headers: [
				{ key: "X-Api-Key", value: "<redacted>", enabled: true },
				{ key: "X-Other", value: "v", enabled: true },
			],
			sentHeaders: { "X-TENANT": "<redacted>", "Proxy-Authorization": "<redacted>" },
			requestHeaders: { Accept: "*/*" },
		});
	});

	test("does not read a member named like a header set as one unless it holds headers", () => {
		const node = { disabledSystemHeaders: ["Cookie"], headers: "Cookie: x" };
		expect(withholdRunOutput(node, rule)).toEqual(node);
	});
});

describe("runOutputShape", () => {
	const scopes = () => ({
		getGlobals: vi.fn().mockResolvedValue({
			variables: { g: { value: "global-secret", secret: true } },
		}),
		listEnvironments: vi.fn().mockResolvedValue([
			{
				variables: {
					e: { value: "env-secret", secret: true, enabled: false },
					loose: { value: "flagged-loosely", secret: "true" },
					empty: { value: "", secret: true },
				},
			},
		]),
		listCollections: vi.fn().mockResolvedValue([
			{
				variables: { c: { value: "collection-secret", secret: true } },
				auth: { mode: "apikey", key: "X-Col-Key" },
			},
		]),
		listAllRequests: vi
			.fn()
			.mockResolvedValue([{ auth: { mode: "apikey", key: "X-Req-Key", in: "query" } }]),
	});
	const ctx = (client: ReturnType<typeof scopes>, reveal = false) => ({
		client,
		config: resolveSafetyConfig({ revealSecretsToAgents: reveal }),
	});

	const sample = {
		body: "global-secret env-secret collection-secret flagged-loosely",
		headers: { "X-Col-Key": "c", "X-Req-Key": "q", "X-Inline-Key": "i" },
	};

	test("masks every scope's secret, disabled ones included, and the API-key headers the workspace names", async () => {
		const withhold = await runOutputShape(ctx(scopes()));
		expect(withhold(sample)).toEqual({
			body: "<redacted> <redacted> <redacted> flagged-loosely",
			// A query-placed key names its header too: the engine's rule.
			headers: { "X-Col-Key": "<redacted>", "X-Req-Key": "<redacted>", "X-Inline-Key": "i" },
		});
	});

	test("takes an inline auth block's API-key header beside the workspace's", async () => {
		const withhold = await runOutputShape(ctx(scopes()), undefined, [
			{ mode: "apikey", key: "X-Inline-Key" },
		]);
		expect(withhold(sample)).toMatchObject({ headers: { "X-Inline-Key": "<redacted>" } });
	});

	test("masks the literal credentials a stored auth block holds, wherever the engine wrote them", async () => {
		const client = scopes();
		client.listCollections.mockResolvedValue([
			{ auth: { mode: "bearer", token: "col-bearer-literal" } },
			{ auth: { mode: "oauth2", config: { clientSecret: "col-client-secret" } } },
		]);
		client.listAllRequests.mockResolvedValue([
			{ auth: { mode: "apikey", key: "api_key", value: "req-query-key", in: "query" } },
			{
				auth: {
					mode: "oauth2",
					postman: {
						type: "oauth2",
						oauth2: [{ key: "clientSecret", value: "postman-row-secret" }],
					},
				},
			},
			// Neither is a credential: a reference names one, an empty value holds none.
			{ auth: { mode: "bearer", token: "{{bearerToken}}" } },
			{ auth: { mode: "basic", username: "visible-user", password: "" } },
		]);
		const withhold = await runOutputShape(ctx(client));
		expect(
			withhold({
				url: "https://x.test/v1?api_key=req-query-key&user=visible-user",
				body: "col-bearer-literal col-client-secret postman-row-secret {{bearerToken}}",
			})
		).toEqual({
			url: "https://x.test/v1?api_key=<redacted>&user=visible-user",
			body: "<redacted> <redacted> <redacted> {{bearerToken}}",
		});
	});

	test("is the identity with reveal on, and reads nothing to be it", async () => {
		const client = scopes();
		const withhold = await runOutputShape(ctx(client, true));
		expect(withhold(sample)).toBe(sample);
		for (const read of Object.values(client)) expect(read).not.toHaveBeenCalled();
	});

	test("fails closed when one read fails, naming it, rather than masking with the rest", async () => {
		const client = scopes();
		client.listEnvironments.mockRejectedValue(new Error("down"));
		const shape = runOutputShape(ctx(client));
		await expect(shape).rejects.toBeInstanceOf(MaskingIncompleteError);
		await expect(shape).rejects.toThrow(/the environments lookup .*failed \(down\)/);
	});

	test("names every read that failed, a read that throws before it returns a promise included", async () => {
		const shape = runOutputShape(
			ctx({
				getGlobals: vi.fn().mockRejectedValue(new Error("down")),
				listEnvironments: vi.fn().mockResolvedValue([]),
				listCollections: vi.fn().mockRejectedValue(new Error("down")),
				listAllRequests: vi.fn(() => {
					throw new Error("not a function");
				}),
			})
		);
		await expect(shape).rejects.toThrow(/the globals, collections, requests lookups /);
	});
});
