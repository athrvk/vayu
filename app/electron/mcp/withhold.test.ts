/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file withhold.test.ts
 * @brief The shapes `withholdDiagnoseCredentials` leaves alone (#1805): an
 *        answer with nothing to strip is returned as it came; the header rows,
 *        URL and Params rows `withholdRowSecrets` masks (#1837) and the lists
 *        `withholdReorderRows` walks;
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
	withholdRequestUrl,
	withholdRowSecrets,
	withholdRunOutput,
	specDiffRequestsToRead,
	withholdSpecDiffChanges,
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

describe("withholdRowSecrets url and params", () => {
	const url = "https://u:p@h/x?api_key=S&page=2";
	const params = [
		{ key: "api_key", value: "S", enabled: true },
		{ key: "page", value: "2", enabled: true },
	];

	test("a saved request keeps its user, loses the password and the credential values", () => {
		expect(withholdRowSecrets({ id: "r", url, params })).toEqual({
			id: "r",
			url: "https://u@h/x?api_key=&page=2",
			params: [
				{ key: "api_key", enabled: true, valueWithheld: true },
				{ key: "page", value: "2", enabled: true },
			],
		});
	});

	test("a row without a url or params gains neither", () => {
		expect(withholdRowSecrets({ id: "r", name: "n" })).toEqual({ id: "r", name: "n" });
	});

	test("a {{variable}} reference, an empty value and a disabled row are handled as headers are", () => {
		const rows = [
			{ key: "api_key", value: "{{API_KEY}}", enabled: true },
			{ key: "token", value: "", enabled: true },
			{ key: "password", value: "hunter2", enabled: false },
		];
		expect(withholdRowSecrets({ params: rows })).toEqual({
			params: [rows[0], rows[1], { key: "password", enabled: false, valueWithheld: true }],
		});
	});

	test("the name is matched whole and by ASCII fold, with no trimming or decoding", () => {
		const rows = [
			{ key: "API_KEY", value: "S", enabled: true },
			{ key: " api_key", value: "S", enabled: true },
			{ key: "api%5Fkey", value: "S", enabled: true },
			{ key: "api_keys", value: "S", enabled: true },
			// U+212A lowercases to `k` under `toLowerCase`, which the engine's fold does not.
			{ key: "\u212Aey", value: "S", enabled: true },
			{ key: "ap\u0130_key", value: "S", enabled: true },
		];
		expect(withholdRowSecrets({ params: rows })).toEqual({
			params: [{ key: "API_KEY", enabled: true, valueWithheld: true }, ...rows.slice(1)],
		});
	});

	test("`code` and `key` are data, not credentials", () => {
		const rows = [
			{ key: "code", value: "US", enabled: true },
			{ key: "key", value: "k1", enabled: true },
		];
		expect(withholdRowSecrets({ url: "/p?code=US&key=k1", params: rows })).toEqual({
			url: "/p?code=US&key=k1",
			params: rows,
		});
	});

	test("an API-key auth in the query names its own parameter, matched as written", () => {
		const auth = { mode: "apikey", key: "Tenant", in: "query" };
		const rows = [
			{ key: "tenant", value: "S", enabled: true },
			{ key: "tenant ", value: "S", enabled: true },
		];
		expect(
			withholdRowSecrets({ auth, url: "/p?tenant=S&Tenant =S", params: rows })
		).toMatchObject({
			url: "/p?tenant=&Tenant =S",
			params: [{ key: "tenant", enabled: true, valueWithheld: true }, rows[1]],
		});
	});

	test.each([
		["a header placement", { mode: "apikey", key: "Tenant", in: "header" }],
		["no placement", { mode: "apikey", key: "Tenant" }],
		["another mode", { mode: "bearer", key: "Tenant", in: "query" }],
		["an empty key", { mode: "apikey", key: "", in: "query" }],
		["a non-string key", { mode: "apikey", key: 7, in: "query" }],
	])("an API-key auth with %s names no query parameter", (_name, auth) => {
		const row = { url: "/p?tenant=S", params: [{ key: "tenant", value: "S" }] };
		expect(withholdRowSecrets({ ...row, auth })).toMatchObject(row);
	});

	test.each([
		["not a list", "none"],
		["null", null],
		[
			"a malformed row, or one with no key or a non-string value",
			["api_key=S", { value: "S" }, { key: "api_key", value: 5 }, { key: 7, value: "S" }],
		],
	])("params that are %s pass through", (_name, params) => {
		expect(withholdRowSecrets({ params })).toEqual({ params });
	});
});

describe("withholdRequestUrl", () => {
	test.each([
		["a password", "https://u:p@h/x", "https://u@h/x"],
		["no scheme", "u:p@h:80/x", "u@h:80/x"],
		["an at sign inside the password", "http://u:p@ss@h/x", "http://u@h/x"],
		["a colon inside the password", "http://u:p:q@h", "http://u@h"],
		["a user with no password", "https://u@h/x", "https://u@h/x"],
		["an empty password", "https://u:@h/x", "https://u:@h/x"],
		["a {{variable}} password", "https://u:{{pw}}@h/x", "https://u:{{pw}}@h/x"],
		["a template host", "{{baseUrl}}/x?a=1", "{{baseUrl}}/x?a=1"],
		["a template user", "https://{{user}}:p@h/x", "https://{{user}}@h/x"],
		["an at sign past the authority", "https://h/p:q@r", "https://h/p:q@r"],
		["whitespace in a scheme-less authority", "a b:c@d", "a b:c@d"],
		["a slash before the ://", "/p/x://u:p@h", "/p/x://u:p@h"],
		["an at sign only in the query", "https://h/p?e=a@b.c", "https://h/p?e=a@b.c"],
		["a query credential", "https://h/p?api_key=S&page=2", "https://h/p?api_key=&page=2"],
		["a query credential name in any case", "/p?Access_Token=S", "/p?Access_Token="],
		["a bare name and an empty value", "/p?token&api_key=&x", "/p?token&api_key=&x"],
		["a {{variable}} value", "/p?api_key={{k}}&token=S", "/p?api_key={{k}}&token="],
		[
			"a fragment credential",
			"https://h/cb#access_token=S&state=1",
			"https://h/cb#access_token=&state=1",
		],
		[
			"a query and a fragment",
			"https://h/cb?a=1&sig=S#id_token=T",
			"https://h/cb?a=1&sig=#id_token=",
		],
		["a ? inside the fragment", "https://h/cb#a?token=S", "https://h/cb#a?token=S"],
		["a value holding =", "/p?token=a=b", "/p?token="],
		["nothing to hide", "https://h/p?page=2&code=US", "https://h/p?page=2&code=US"],
		["an empty string", "", ""],
	])("%s", (_name, input, expected) => {
		expect(withholdRequestUrl(input, undefined)).toBe(expected);
	});

	test("an API-key auth in the query adds its key to the names", () => {
		const auth = { mode: "apikey", key: "tenant", in: "query" };
		expect(withholdRequestUrl("/p?Tenant=S&page=2", auth)).toBe("/p?Tenant=&page=2");
		expect(withholdRequestUrl("/p?Tenant=S&page=2", { ...auth, in: "header" })).toBe(
			"/p?Tenant=S&page=2"
		);
	});

	test.each([[null], [undefined], [7], [{ href: "u:p@h" }], [["u:p@h"]]])(
		"%j is not a string and passes through",
		(url) => {
			expect(withholdRequestUrl(url, undefined)).toBe(url);
		}
	);
});

describe("withholdSpecDiffChanges", () => {
	/** One changed entry holding one field change, the way `diff_spec` hands them over. */
	const change = (field: string, current: unknown) => [
		{ requestId: "r", fields: [{ field, current, next: "the document's value" }] },
	];
	/** The stored auth of request `r`: read, and none. */
	const NO_AUTH = new Map([["r", undefined]]);
	const withheld = (field: string) => [
		{
			requestId: "r",
			fields: [{ field, next: "the document's value", currentWithheld: true }],
		},
	];

	test.each([
		["a url password", "https://u:p@h/x"],
		["a url credential query value", "https://h/x?api_key=S&page=2"],
		["a url credential fragment value", "https://h/cb#access_token=S"],
		["a url cut inside its userinfo", "https://user:pas\u2026"],
		["a url cut inside its host", "https://api.exam\u2026"],
		["a scheme-less url cut inside its authority", "user:pas\u2026"],
	])("withholds %s from a url change", (_name, current) => {
		expect(withholdSpecDiffChanges(change("url", current), NO_AUTH)).toEqual(withheld("url"));
	});

	test.each([
		["a template base", "{{baseUrl}}/me"],
		["an ordinary query", "https://h/x?page=2&code=US"],
		["a user with no password", "https://u@h/x"],
		["a {{variable}} password", "https://u:{{pw}}@h/x"],
		["a url cut past its authority", "https://api.example.com/v1/pets/by-owner/long\u2026"],
		["a url cut inside its query", "https://api.example.com?page=\u2026"],
		["an empty url", ""],
	])("keeps %s in a url change", (_name, current) => {
		expect(withholdSpecDiffChanges(change("url", current), NO_AUTH)).toEqual(
			change("url", current)
		);
	});

	test.each([
		["a credential row", "2: page=2, api_key=S"],
		["a credential row in any case", "1: Access_Token=S"],
		["a disabled credential row", "1: sig=S [off]"],
		["a credential row cut inside its value", "2: page=2, api_key=SEC\u2026"],
	])("withholds %s from a params change", (_name, current) => {
		expect(withholdSpecDiffChanges(change("params", current), NO_AUTH)).toEqual(
			withheld("params")
		);
	});

	test.each([
		["ordinary rows", "2: page=2, code=US"],
		["a {{variable}} value", "1: api_key={{key}}"],
		["a credential name with no value", "1: api_key"],
		["a credential name cut before its value", "2: page=2, api_key\u2026"],
		["no rows", "none"],
	])("keeps %s in a params change", (_name, current) => {
		expect(withholdSpecDiffChanges(change("params", current), NO_AUTH)).toEqual(
			change("params", current)
		);
	});

	test("still withholds a credential header, and leaves fields it does not judge", () => {
		expect(
			withholdSpecDiffChanges(change("headers", "1: Authorization=Bearer t"), NO_AUTH)
		).toEqual(withheld("headers"));
		expect(withholdSpecDiffChanges(change("body", "json: api_key=S"), NO_AUTH)).toEqual(
			change("body", "json: api_key=S")
		);
		expect(withholdSpecDiffChanges(change("constructor", "https://u:p@h"), NO_AUTH)).toEqual(
			change("constructor", "https://u:p@h")
		);
	});

	describe("with the request's stored auth", () => {
		const apiKeyIn = (where: string, key: unknown) => ({ mode: "apikey", in: where, key });
		const tenantAuth = new Map([["r", apiKeyIn("query", "tenant")]]);

		test.each([
			["url", "https://h/x?tenant=ACME-SECRET&page=2"],
			["url", "https://h/x#TENANT=ACME-SECRET"],
			["params", "2: page=2, Tenant=ACME-SECRET"],
		])("withholds a %s change holding the custom API-key query name", (field, current) => {
			expect(withholdSpecDiffChanges(change(field, current), tenantAuth)).toEqual(
				withheld(field)
			);
			// Without the auth the same line is an ordinary one: the gap this closes.
			expect(withholdSpecDiffChanges(change(field, current), NO_AUTH)).toEqual(
				change(field, current)
			);
		});

		test.each([
			["an API key placed in a header", apiKeyIn("header", "tenant")],
			["an API key with no name", apiKeyIn("query", "")],
			["a bearer token", { mode: "bearer", token: "t" }],
			["no auth", undefined],
		])("keeps the name `tenant` as an ordinary one under %s", (_name, auth) => {
			const current = "2: page=2, tenant=acme";
			expect(
				withholdSpecDiffChanges(change("params", current), new Map([["r", auth]]))
			).toEqual(change("params", current));
		});

		test("keeps a {{variable}} under the API-key name", () => {
			expect(
				withholdSpecDiffChanges(change("params", "1: tenant={{tenant}}"), tenantAuth)
			).toEqual(change("params", "1: tenant={{tenant}}"));
		});

		test("judges each entry by its own request's auth", () => {
			const changed = [
				{ requestId: "a", fields: [{ field: "params", current: "1: tenant=S" }] },
				{ requestId: "b", fields: [{ field: "params", current: "1: tenant=S" }] },
			];
			const auths = new Map([
				["a", apiKeyIn("query", "tenant")],
				["b", undefined],
			]);
			expect(withholdSpecDiffChanges(changed, auths)).toEqual([
				{ requestId: "a", fields: [{ field: "params", currentWithheld: true }] },
				changed[1],
			]);
		});
	});

	describe("when the request's auth could not be read", () => {
		const nothingRead = new Map<string, unknown>();

		test.each([
			["url", "https://h/x?page=2"],
			["params", "1: page=2"],
		])("withholds a %s change whatever it reads", (field, current) => {
			expect(withholdSpecDiffChanges(change(field, current), nothingRead)).toEqual(
				withheld(field)
			);
		});

		test("withholds an entry that names no request", () => {
			const changed = [{ fields: [{ field: "url", current: "https://h/x?page=2" }] }];
			expect(withholdSpecDiffChanges(changed, new Map([["r", undefined]]))).toEqual([
				{ fields: [{ field: "url", currentWithheld: true }] },
			]);
		});

		test("leaves a field the auth does not bear on, and a current with nothing to hide", () => {
			expect(withholdSpecDiffChanges(change("body", "json: x=1"), nothingRead)).toEqual(
				change("body", "json: x=1")
			);
			expect(withholdSpecDiffChanges(change("url", ""), nothingRead)).toEqual(
				change("url", "")
			);
			expect(withholdSpecDiffChanges(change("url", null), nothingRead)).toEqual(
				change("url", null)
			);
		});
	});

	test.each([
		["a current that is not text", change("url", 7)],
		["a field with no name", [{ fields: [{ current: "https://u:p@h" }] }]],
		["an entry with no fields", [{ requestId: "r" }]],
		["a non-list", "none"],
	])("passes %s through", (_name, changed) => {
		expect(withholdSpecDiffChanges(changed, NO_AUTH)).toEqual(changed);
	});
});

describe("specDiffRequestsToRead", () => {
	const entry = (requestId: unknown, ...fields: string[]) => ({
		requestId,
		fields: fields.map((field) => ({ field })),
	});

	test("names each request with a url or params change once", () => {
		expect(
			specDiffRequestsToRead([
				entry("a", "url"),
				entry("b", "headers", "params"),
				entry("a", "params"),
				entry("c", "headers", "body"),
			])
		).toEqual(["a", "b"]);
	});

	test.each([
		["a non-list", "none"],
		["an entry with no request id", [entry(undefined, "url")]],
		["an entry with no fields", [{ requestId: "a" }]],
		["a non-entry", [null, 7]],
	])("names nothing for %s", (_name, changed) => {
		expect(specDiffRequestsToRead(changed)).toEqual([]);
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
		// Lowercase hex, as the engine writes it.
		expect(secretForms(["ab\u001fcd"])).toContain("ab\\u001fcd");
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
