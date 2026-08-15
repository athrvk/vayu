/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An OpenAPI import keeps the contract it was made from (issue #638).
 *
 * Before this, the document was read and thrown away: the requests it produced
 * knew nothing about which operation they were, and the collection knew nothing
 * about which document it came from. What is asserted here is the whole chain -
 * the parser stamping identity, the root carrying the document verbatim, and the
 * apply payload turning both into a `specs` section plus a binding - because a
 * link missing anywhere in it leaves a stored spec nothing references, or a
 * binding pointing at nothing.
 */

import { describe, it, expect, vi } from "vitest";
import { parseImport } from "./factory";
import { assignTempIds } from "./assign-ids";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import type { ImportOptions, ImportResult } from "./types";
import type { ImportApplyRequest } from "@/types";

const opts: ImportOptions = { importEnvironments: true, importScripts: true };

const OPENAPI_V3 = JSON.stringify({
	openapi: "3.0.3",
	info: { title: "Pets API" },
	servers: [{ url: "https://api.example.com" }],
	paths: {
		"/pets": {
			get: { operationId: "listPets", tags: ["pets"], summary: "List pets" },
			post: { summary: "Create a pet", tags: ["pets"] },
		},
		"/pets/{petId}": {
			get: { operationId: "getPet", summary: "One pet" },
		},
	},
});

const SWAGGER_V2 = JSON.stringify({
	swagger: "2.0",
	info: { title: "Pets API" },
	host: "api.example.com",
	paths: {
		"/pets/{petId}": { get: { operationId: "getPet", summary: "One pet" } },
	},
});

const POSTMAN = JSON.stringify({
	info: { name: "Team", schema: "https://schema.getpostman.com/json/collection/v2.1.0/" },
	item: [{ name: "Ping", request: { method: "GET", url: "https://example.com/ping" } }],
});

/** Every request in the tree, roots and tag folders alike. */
function allRequests(result: ImportResult) {
	const out: ImportResult["collections"][number]["requests"] = [];
	const walk = (c: ImportResult["collections"][number]) => {
		out.push(...c.requests);
		c.children.forEach(walk);
	};
	result.collections.forEach(walk);
	return out;
}

describe("OpenAPI parsers record operation identity", () => {
	it("names the operation of every v3 request, by templated path", () => {
		const result = parseImport(OPENAPI_V3, opts);

		const identities = allRequests(result).map((r) => r.specOperation);
		expect(identities).toEqual(
			expect.arrayContaining([
				{ operationId: "listPets", method: "GET", path: "/pets" },
				// No `operationId`: the document declares none, and an invented one
				// would be an identity a re-fetch could not reproduce.
				{ method: "POST", path: "/pets" },
				{ operationId: "getPet", method: "GET", path: "/pets/{petId}" },
			])
		);
		// The templated path, not the URL the request will send - the URL carries
		// `{{baseUrl}}` and Vayu's own variable syntax.
		const one = allRequests(result).find((r) => r.specOperation?.operationId === "getPet");
		expect(one?.url).toBe("{{baseUrl}}/pets/{{petId}}");
		expect(one?.specOperation?.path).toBe("/pets/{petId}");
	});

	it("names the operation of a Swagger 2.0 request the same way", () => {
		const result = parseImport(SWAGGER_V2, opts);
		expect(allRequests(result)[0].specOperation).toEqual({
			operationId: "getPet",
			method: "GET",
			path: "/pets/{petId}",
		});
	});

	it("carries the document verbatim on the root, for both formats", () => {
		expect(parseImport(OPENAPI_V3, opts).collections[0].spec?.content).toBe(OPENAPI_V3);
		expect(parseImport(SWAGGER_V2, opts).collections[0].spec?.content).toBe(SWAGGER_V2);
		// The tag folder is part of the same document, not a document of its own.
		expect(parseImport(OPENAPI_V3, opts).collections[0].children[0].spec).toBeUndefined();
	});

	it("imports an operation under a malformed path key without an identity", () => {
		// The engine refuses a `specOperation.path` that does not start with `/`,
		// and one bad key in a document must not turn the whole import into a
		// rejected payload. The request still lands; it simply names no operation.
		const malformed = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "Odd" },
			paths: { pets: { get: { operationId: "listPets" } } },
		});

		const requests = allRequests(parseImport(malformed, opts));

		expect(requests).toHaveLength(1);
		expect(requests[0].specOperation).toBeUndefined();
	});

	it("leaves a Postman import with no contract at all", () => {
		const result = parseImport(POSTMAN, opts);
		expect(result.collections[0].spec).toBeUndefined();
		expect(allRequests(result)[0].specOperation).toBeUndefined();
	});

	it("records the fetched URL on the document, and only when there was one", () => {
		const fetched = parseImport(OPENAPI_V3, opts, {
			sourceUrl: "https://api.example.com/openapi.json",
		});
		expect(fetched.collections[0].spec?.sourceUrl).toBe("https://api.example.com/openapi.json");

		// A file or a paste has nothing to re-fetch from, and `undefined` is how
		// the payload spells that - `sourceUrl: ""` would look like an origin.
		expect(
			parseImport(OPENAPI_V3, opts, { fileName: "petstore.json" }).collections[0].spec
		).toEqual({ content: OPENAPI_V3 });
	});
});

/** Captures the one payload the orchestrator sends. */
function capture(): { api: ImportApi; sent: () => ImportApplyRequest } {
	let payload: ImportApplyRequest | undefined;
	const api: ImportApi = {
		applyImport: vi.fn(async (sent: ImportApplyRequest) => {
			payload = sent;
			const idMap: Record<string, string> = {};
			const prefix = {
				collections: "col_",
				requests: "req_",
				environments: "env_",
				specs: "spec_",
			} as const;
			for (const kind of ["collections", "requests", "environments", "specs"] as const) {
				for (const item of sent[kind]) idMap[item.tempId] = `${prefix[kind]}${item.tempId}`;
			}
			return { idMap };
		}),
		getGlobals: vi.fn(async () => ({ id: "globals", variables: {}, updatedAt: "0" })),
		updateGlobals: vi.fn(async (variables) => ({ id: "globals", variables, updatedAt: "1" })),
	};
	return { api, sent: () => payload! };
}

describe("the apply payload binds the collection to the document", () => {
	it("sends the spec as its own section and references it by temp id", async () => {
		const result = assignTempIds(
			parseImport(OPENAPI_V3, opts, { sourceUrl: "https://api.example.com/openapi.json" })
		);
		const { api, sent } = capture();

		const idMap = await new ImportOrchestrator(api).run(result, opts);

		const payload = sent();
		expect(payload.specs).toEqual([
			{
				tempId: "s1",
				content: OPENAPI_V3,
				sourceUrl: "https://api.example.com/openapi.json",
			},
		]);
		// The root binds it; a tag folder does not - one document, one binding.
		const [root, tagFolder] = payload.collections;
		expect(root.openapi).toEqual({ specTempId: "s1" });
		expect(tagFolder.openapi).toBeUndefined();
		// And the caller can find the collection the document landed under, which
		// is what the spec-file store is keyed by.
		expect(idMap["c1"]).toBe("col_c1");
	});

	it("carries each request's identity through to the payload", async () => {
		const result = assignTempIds(parseImport(OPENAPI_V3, opts));
		const { api, sent } = capture();

		await new ImportOrchestrator(api).run(result, opts);

		const identified = sent().requests.filter((r) => r.specOperation);
		expect(identified).toHaveLength(3);
		expect(identified.map((r) => r.specOperation?.method).sort()).toEqual([
			"GET",
			"GET",
			"POST",
		]);
	});

	it("sends no spec and no binding for a format that has neither", async () => {
		const result = assignTempIds(parseImport(POSTMAN, opts));
		const { api, sent } = capture();

		await new ImportOrchestrator(api).run(result, opts);

		const payload = sent();
		// `[]`, not absent: the section is always stated, so one payload shape
		// serves every format.
		expect(payload.specs).toEqual([]);
		expect(payload.collections[0].openapi).toBeUndefined();
		// Absent rather than null - the engine reads null as "clear it", which is
		// a different statement from "this format never had one".
		expect("specOperation" in payload.requests[0]).toBe(false);
	});

	it("refuses to send a spec whose temp id was never assigned", async () => {
		// The pre-pass is required, and the spec is the newest thing it has to
		// stamp. With only its id missing, a payload would otherwise go out
		// carrying `tempId: undefined` and a binding referencing it - so the check
		// has to name the spec, not fail later on a map lookup.
		const result = assignTempIds(parseImport(OPENAPI_V3, opts));
		delete result.collections[0].spec?.tempId;
		const { api } = capture();

		await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(
			/assignTempIds.*\(spec has no tempId\)/
		);
	});
});
