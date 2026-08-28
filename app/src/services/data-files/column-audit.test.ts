/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { auditDataColumns, type AuditableRequest } from "./column-audit";

function request(overrides: Partial<AuditableRequest> = {}): AuditableRequest {
	return {
		url: "https://api.example.com/users",
		params: [],
		headers: [],
		body: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		// Already walked through the collection chain by the caller - `inherit` is
		// not a value this function can be handed.
		resolvedAuth: { mode: "none" },
		...overrides,
	};
}

describe("auditDataColumns", () => {
	it("splits declared columns into referenced and unreferenced", () => {
		const audit = auditDataColumns(
			["id", "email", "plan"],
			[request({ url: "https://api.example.com/users/{{data.id}}" })]
		);
		expect(audit.referenced).toEqual(["id"]);
		expect(audit.unreferenced).toEqual(["email", "plan"]);
		expect(audit.undeclared).toEqual([]);
	});

	it("reports a referenced column no contract declares", () => {
		// The typo case, and the reason the panel exists: nothing says so until a
		// run reaches the request and sends the braces literally.
		const audit = auditDataColumns(["email"], [request({ url: "https://x/{{data.emial}}" })]);
		expect(audit.undeclared).toEqual(["emial"]);
		expect(audit.referenced).toEqual([]);
	});

	it("walks every field the engine's binder walks", () => {
		// URL, params (folded into the URL by composition), header names and
		// values, body text and form field names and values. A field missing here
		// is a column reported unreferenced while a run binds it.
		const declared = ["inUrl", "inParamKey", "inParamValue", "inHeaderKey", "inHeaderValue"];
		const audit = auditDataColumns(declared, [
			request({
				url: "https://x/{{data.inUrl}}",
				params: [
					{ key: "{{data.inParamKey}}", value: "v", enabled: true },
					{ key: "k", value: "{{data.inParamValue}}", enabled: true },
				],
				headers: [
					{ key: "X-{{data.inHeaderKey}}", value: "v", enabled: true },
					{ key: "Authorization", value: "Bearer {{data.inHeaderValue}}", enabled: true },
				],
			}),
		]);
		expect(audit.referenced).toEqual(declared);
		expect(audit.unreferenced).toEqual([]);
	});

	it("reads a text body and both halves of a form field", () => {
		const audit = auditDataColumns(
			["body", "fieldKey", "fieldValue"],
			[
				request({ body: { mode: "json", content: '{"e":"{{data.body}}"}' } }),
				request({
					body: {
						mode: "form-data",
						fields: [
							{ key: "{{data.fieldKey}}", value: "v", enabled: true },
							{ key: "k", value: "{{data.fieldValue}}", enabled: true },
						],
					},
				}),
			]
		);
		expect(audit.unreferenced).toEqual([]);
	});

	it("deduplicates across requests and keeps the contract's order", () => {
		const audit = auditDataColumns(
			["id", "email"],
			[
				request({ url: "https://x/{{data.email}}/{{data.email}}" }),
				request({ url: "https://x/{{data.id}}" }),
			]
		);
		expect(audit.referenced).toEqual(["id", "email"]);
	});

	it("finds a literal column in a script and does not call it unreferenced", () => {
		// The conservative direction: telling someone a column is unused when a
		// script reads it is what gets a working column deleted.
		const audit = auditDataColumns(
			["plan"],
			[request({ postRequestScript: 'const p = pm.iterationData.get("plan");' })]
		);
		expect(audit.inScripts).toEqual(["plan"]);
		expect(audit.unreferenced).toEqual([]);
		// Still not "referenced": that bucket is the verified one.
		expect(audit.referenced).toEqual([]);
	});

	it("reads the guarded and the has() spellings a script actually uses", () => {
		const audit = auditDataColumns(
			["a", "b"],
			[
				request({
					preRequestScript: 'pm.iterationData?.get("a");',
					postRequestScript: "if (pm.iterationData.has('b')) {}",
				}),
			]
		);
		expect(audit.inScripts).toEqual(["a", "b"]);
	});

	it("finds nothing in a computed argument, which is what best-effort means", () => {
		const audit = auditDataColumns(
			["plan"],
			[request({ postRequestScript: "const k = 'plan'; pm.iterationData.get(k);" })]
		);
		expect(audit.inScripts).toEqual([]);
		expect(audit.unreferenced).toEqual(["plan"]);
	});

	/*
	 * Auth credentials (issue #729).
	 *
	 * The engine has bound rows into credentials since #591, and the walk here
	 * has to be the same set `walk_auth_credentials` visits - no wider, or the
	 * panel claims a binding the engine refuses; no narrower, and it reports a
	 * column bound on every iteration as referenced by nothing.
	 */
	it("walks the credentials a row binds, in every mode that carries one", () => {
		const audit = auditDataColumns(
			["token", "user", "password", "keyName", "keyValue"],
			[
				request({ resolvedAuth: { mode: "bearer", token: "{{data.token}}" } }),
				request({
					resolvedAuth: {
						mode: "basic",
						username: "{{data.user}}",
						password: "{{data.password}}",
					},
				}),
				request({
					resolvedAuth: {
						mode: "apikey",
						key: "{{data.keyName}}",
						value: "{{data.keyValue}}",
						in: "header",
					},
				}),
			]
		);
		expect(audit.referenced).toEqual(["token", "user", "password", "keyName", "keyValue"]);
		expect(audit.unreferenced).toEqual([]);
	});

	it("does not count a token in an OAuth 2.0 config, which nothing binds", () => {
		// The config is the input to a token acquisition that happens once per
		// plan, so a data token there is refused rather than bound (#591).
		// Reporting it as referenced would promise a binding that never happens.
		const audit = auditDataColumns(
			["clientId"],
			[
				request({
					resolvedAuth: {
						mode: "oauth2",
						config: {
							grantType: "client_credentials",
							accessTokenUrl: "https://auth.example.com/token",
							clientId: "{{data.clientId}}",
						},
					},
				}),
			]
		);
		expect(audit.referenced).toEqual([]);
		expect(audit.undeclared).toEqual([]);
		expect(audit.unreferenced).toEqual(["clientId"]);
	});

	it("scans a collection's scripts, which run around every step", () => {
		// Root-to-leaf ahead of the request's own (`compose_script_parts`), so a
		// column read once on a parent is read on every step beneath it.
		const audit = auditDataColumns(
			["plan"],
			[request()],
			['pm.iterationData.get("plan");', ""]
		);
		expect(audit.inScripts).toEqual(["plan"]);
		// The conservative direction, same as a request's own script scan.
		expect(audit.unreferenced).toEqual([]);
		expect(audit.referenced).toEqual([]);
	});

	it("ignores a name outside the namespace", () => {
		const audit = auditDataColumns(
			["id"],
			[request({ url: "https://x/{{baseUrl}}/{{data.}}/{{data.id}}" })]
		);
		expect(audit.undeclared).toEqual([]);
		expect(audit.referenced).toEqual(["id"]);
	});

	/*
	 * Bare column names (issue #1007): Postman binds a dataset's columns bare,
	 * and a bound row now substitutes `{{column}}` exactly as it substitutes
	 * `{{data.column}}` - so a scan that recognised only the prefixed spelling
	 * would call a working, bound `{{username}}` "declared but not referenced",
	 * which is the false negative that gets a working column deleted.
	 */
	describe("bare column names (issue #1007)", () => {
		it("counts a bare {{column}} as a reference when it names a declared column", () => {
			// Revert to the pre-#1007 scan (`dataColumnName` only) and this column
			// falls to `unreferenced` instead - the exact false negative the fix
			// exists to close.
			const audit = auditDataColumns(
				["username"],
				[request({ url: "https://x/{{username}}" })]
			);
			expect(audit.referenced).toEqual(["username"]);
			expect(audit.unreferenced).toEqual([]);
		});

		it("does not treat a bare name outside the contract as any kind of column reference", () => {
			// `baseUrl` is an ordinary variable token here, not a column typo - it
			// must land in neither `undeclared` (that bucket is for a `data.*` typo)
			// nor `referenced`. Widening the bare match to "every name" would flood
			// `undeclared` with every ordinary variable a request ever uses.
			const audit = auditDataColumns(
				["username"],
				[request({ url: "https://x/{{baseUrl}}/{{username}}" })]
			);
			expect(audit.undeclared).toEqual([]);
			expect(audit.referenced).toEqual(["username"]);
		});

		it("collapses both spellings of the same column into one reference", () => {
			const audit = auditDataColumns(
				["id"],
				[request({ url: "https://x/{{id}}/{{data.id}}" })]
			);
			expect(audit.referenced).toEqual(["id"]);
		});

		it("counts a bare column bound into a credential the request configures", () => {
			// The #729 walk (auth) has to see the bare spelling too, not just URL
			// and headers - a basic-auth pair written Postman-style is exactly the
			// #1007 flagship case.
			const audit = auditDataColumns(
				["user", "password"],
				[
					request({
						resolvedAuth: {
							mode: "basic",
							username: "{{user}}",
							password: "{{password}}",
						},
					}),
				]
			);
			expect(audit.referenced).toEqual(["user", "password"]);
			expect(audit.unreferenced).toEqual([]);
		});
	});
});
