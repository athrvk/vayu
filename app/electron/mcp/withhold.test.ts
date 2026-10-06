/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file withhold.test.ts
 * @brief The shapes `withholdDiagnoseCredentials` leaves alone (#1805): an
 *        answer with nothing to strip is returned as it came; and the header
 *        rows `withholdRowSecrets` masks and the lists `withholdReorderRows`
 *        walks (#1809).
 */

import { describe, expect, test } from "vitest";
import {
	withholdDiagnoseCredentials,
	withholdReorderRows,
	withholdRowSecrets,
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

	test.each([
		["a query-placed key", { mode: "apikey", key: "X-Tenant-Key", in: "query" }],
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
