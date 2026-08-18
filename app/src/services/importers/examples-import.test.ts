/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saved example responses survive an import (issue #481).
 *
 * Every parser here used to drop the half of the source that says what comes
 * back: Postman's `item.response[]` was never read, and no code path visited an
 * OpenAPI operation's `responses` at all. The loss was silent - not even a
 * skip counter - so these tests assert the mapping *and* the count the preview
 * shows, which is the only place a user can see that anything arrived.
 *
 * Mutation-check: deleting the `item.response` read in `pmExamples`, or the
 * `buildExamples` call in `buildOperation`, fails the first test of each
 * parser's block; reverting the payload-index `order` in the orchestrator's
 * forwarding fails the nesting test.
 */

import { describe, it, expect, vi } from "vitest";
import { PostmanV21Parser } from "./postman";
import { OpenApiV3Parser } from "./openapi-v3";
import { OpenApiV2Parser } from "./openapi-v2";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignTempIds } from "./assign-ids";
import type { ImportApplyRequest } from "@/types";
import type { ImportResult, RequestDraft } from "./types";
import { requestsOf } from "@/test/import-drafts";

const opts = { importEnvironments: true, importScripts: true };

/** A Postman v2.1 collection carrying one request with @p responses saved on it. */
function postmanWith(responses: unknown[]): Record<string, unknown> {
	return {
		info: { name: "Sample", schema: "https://schema.getpostman.com/json/collection/v2.1.0/x" },
		item: [
			{
				name: "Get user",
				request: { method: "GET", url: "https://api.test/users/1" },
				response: responses,
			},
		],
	};
}

function firstRequest(result: ImportResult): RequestDraft {
	return requestsOf(result)[0];
}

describe("Postman saved responses", () => {
	it("maps item.response[] into example drafts", () => {
		const result = new PostmanV21Parser().parse(
			postmanWith([
				{
					name: "OK",
					code: 200,
					header: [{ key: "Content-Type", value: "application/json" }],
					body: '{"id":1}',
				},
				{ name: "Missing", code: 404, body: '{"error":"nope"}' },
			]),
			"",
			opts
		);

		expect(firstRequest(result).examples).toEqual([
			{
				name: "OK",
				status: 200,
				headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
				body: '{"id":1}',
				contentType: "application/json",
			},
			{
				name: "Missing",
				status: 404,
				headers: [],
				body: '{"error":"nope"}',
				contentType: "",
			},
		]);
		// The count the import preview promises the user.
		expect(result.meta.exampleCount).toBe(2);
	});

	it("keeps repeated response headers rather than collapsing them", () => {
		// A JSON object would have kept one Set-Cookie. The stored shape is an
		// entry array precisely so a re-served example sends both.
		const result = new PostmanV21Parser().parse(
			postmanWith([
				{
					name: "Login",
					code: 200,
					header: [
						{ key: "Set-Cookie", value: "a=1" },
						{ key: "Set-Cookie", value: "b=2" },
					],
				},
			]),
			"",
			opts
		);
		expect(firstRequest(result).examples?.[0].headers).toEqual([
			{ key: "Set-Cookie", value: "a=1", enabled: true },
			{ key: "Set-Cookie", value: "b=2", enabled: true },
		]);
	});

	it("defaults a saved response with no code to 200 and names an unnamed one", () => {
		const result = new PostmanV21Parser().parse(postmanWith([{ body: "hi" }]), "", opts);
		expect(firstRequest(result).examples).toEqual([
			{ name: "Example", status: 200, headers: [], body: "hi", contentType: "" },
		]);
	});

	it("steps over a malformed entry and counts it, like any other malformed item", () => {
		const result = new PostmanV21Parser().parse(
			postmanWith([null, { name: "OK", code: 200 }]),
			"",
			opts
		);
		expect(firstRequest(result).examples).toHaveLength(1);
		expect(result.meta.skipped).toContainEqual({ kind: "malformed_item", count: 1 });
	});

	it("omits the field entirely for a request with no saved responses", () => {
		// Absent, not `[]`: the orchestrator forwards presence, and an empty array
		// would tell the engine "this request documents no responses".
		const result = new PostmanV21Parser().parse(postmanWith([]), "", opts);
		expect("examples" in firstRequest(result)).toBe(false);
		expect(result.meta.exampleCount).toBe(0);
	});
});

/** An OpenAPI 3 document with one operation carrying @p responses. */
function openApiWith(responses: Record<string, unknown>): Record<string, unknown> {
	return {
		openapi: "3.0.0",
		info: { title: "API" },
		paths: { "/pets": { get: { summary: "List pets", responses } } },
	};
}

describe("OpenAPI 3 documented responses", () => {
	it("imports a declared example, keyed and named by its status", () => {
		const result = new OpenApiV3Parser().parse(
			openApiWith({
				"200": {
					description: "A pet",
					content: { "application/json": { example: { id: 1, name: "Rex" } } },
				},
			}),
			"",
			opts
		);

		expect(firstRequest(result).examples).toEqual([
			{
				name: "200 - A pet",
				status: 200,
				headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
				body: JSON.stringify({ id: 1, name: "Rex" }, null, 2),
				contentType: "application/json",
			},
		]);
		expect(result.meta.exampleCount).toBe(1);
	});

	it("unwraps the first entry of an `examples` map", () => {
		// The Example Object wraps the payload in `value`; storing the wrapper
		// would put a body on disk that no server would ever send.
		const result = new OpenApiV3Parser().parse(
			openApiWith({
				"200": {
					content: {
						"application/json": {
							examples: { rex: { summary: "A dog", value: { id: 7 } } },
						},
					},
				},
			}),
			"",
			opts
		);
		expect(firstRequest(result).examples?.[0].body).toBe(JSON.stringify({ id: 7 }, null, 2));
		// No description on the response, so the name is the bare status.
		expect(firstRequest(result).examples?.[0].name).toBe("200");
	});

	it("samples the schema when the spec documents no example", () => {
		const result = new OpenApiV3Parser().parse(
			openApiWith({
				"200": {
					content: {
						"application/json": {
							schema: { type: "object", properties: { id: { type: "integer" } } },
						},
					},
				},
			}),
			"",
			opts
		);
		expect(JSON.parse(firstRequest(result).examples![0].body)).toHaveProperty("id");
	});

	it("imports a response that documents no body - 204 is a real answer", () => {
		const result = new OpenApiV3Parser().parse(
			openApiWith({ "204": { description: "No Content" } }),
			"",
			opts
		);
		expect(firstRequest(result).examples).toEqual([
			{ name: "204 - No Content", status: 204, headers: [], body: "", contentType: "" },
		]);
	});

	it("counts a `default` or wildcard response rather than guessing a status, each on its own counter", () => {
		const result = new OpenApiV3Parser().parse(
			openApiWith({
				"200": { description: "ok" },
				default: { description: "Error" },
				"4XX": { description: "Client error" },
			}),
			"",
			opts
		);
		expect(firstRequest(result).examples).toHaveLength(1);
		// Both are skipped for the same reason and reported apart (#710): `default`
		// is conformant and on nearly every operation of a vendor spec, while a
		// `4XX` wildcard is a key the preview should keep flagging as a loss.
		expect(result.meta.skipped).toContainEqual({ kind: "default_response", count: 1 });
		expect(result.meta.skipped).toContainEqual({ kind: "example_no_status", count: 1 });
	});

	it("follows a $ref'd response object", () => {
		const result = new OpenApiV3Parser().parse(
			{
				openapi: "3.0.0",
				info: { title: "API" },
				paths: {
					"/pets": {
						get: { responses: { "200": { $ref: "#/components/responses/Pet" } } },
					},
				},
				components: {
					responses: {
						Pet: {
							description: "A pet",
							content: { "application/json": { example: { id: 1 } } },
						},
					},
				},
			},
			"",
			opts
		);
		expect(firstRequest(result).examples?.[0].name).toBe("200 - A pet");
	});
});

describe("Swagger 2.0 documented responses", () => {
	function swaggerWith(op: Record<string, unknown>): Record<string, unknown> {
		return { swagger: "2.0", info: { title: "API" }, paths: { "/orders": { get: op } } };
	}

	it("imports the MIME-keyed example the 2.0 shape puts on the response itself", () => {
		const result = new OpenApiV2Parser().parse(
			swaggerWith({
				produces: ["application/json"],
				responses: {
					"200": { description: "Orders", examples: { "application/json": [{ id: 1 }] } },
				},
			}),
			"",
			opts
		);
		expect(firstRequest(result).examples).toEqual([
			{
				name: "200 - Orders",
				status: 200,
				headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
				body: JSON.stringify([{ id: 1 }], null, 2),
				contentType: "application/json",
			},
		]);
	});

	it("falls back to the response schema", () => {
		const result = new OpenApiV2Parser().parse(
			swaggerWith({
				responses: {
					"201": {
						description: "Created",
						schema: { type: "object", properties: { id: { type: "string" } } },
					},
				},
			}),
			"",
			opts
		);
		expect(JSON.parse(firstRequest(result).examples![0].body)).toHaveProperty("id");
		expect(firstRequest(result).examples![0].status).toBe(201);
	});
});

describe("ImportOrchestrator forwarding", () => {
	function apiSpy(): { api: ImportApi; calls: ImportApplyRequest[] } {
		const calls: ImportApplyRequest[] = [];
		const api: ImportApi = {
			applyImport: vi.fn(async (payload: ImportApplyRequest) => {
				calls.push(payload);
				const idMap: Record<string, string> = {};
				for (const kind of ["collections", "requests", "environments"] as const) {
					for (const item of payload[kind]) idMap[item.tempId] = `id_${item.tempId}`;
				}
				return { idMap };
			}),
			getGlobals: vi.fn(async () => ({ id: "globals", variables: {}, updatedAt: "0" })),
			updateGlobals: vi.fn(async (variables) => ({
				id: "globals",
				variables,
				updatedAt: "1",
			})),
		};
		return { api, calls };
	}

	it("nests a request's examples on its payload item, in source order", async () => {
		const parsed = new PostmanV21Parser().parse(
			postmanWith([
				{ name: "OK", code: 200 },
				{ name: "Gone", code: 410 },
			]),
			"",
			opts
		);
		const { api, calls } = apiSpy();
		await new ImportOrchestrator(api).run(assignTempIds(parsed), opts);

		expect(calls[0].requests[0].examples).toEqual([
			{ name: "OK", status: 200, headers: [], body: "", contentType: "" },
			{ name: "Gone", status: 410, headers: [], body: "", contentType: "" },
		]);
	});

	it("omits `examples` for a request that has none", async () => {
		const parsed = new PostmanV21Parser().parse(postmanWith([]), "", opts);
		const { api, calls } = apiSpy();
		await new ImportOrchestrator(api).run(assignTempIds(parsed), opts);

		expect("examples" in calls[0].requests[0]).toBe(false);
	});
});
