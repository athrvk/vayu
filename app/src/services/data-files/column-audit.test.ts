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

	it("ignores a name outside the namespace", () => {
		const audit = auditDataColumns(
			["id"],
			[request({ url: "https://x/{{baseUrl}}/{{data.}}/{{data.id}}" })]
		);
		expect(audit.undeclared).toEqual([]);
		expect(audit.referenced).toEqual(["id"]);
	});
});
