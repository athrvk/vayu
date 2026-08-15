/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Matching requests to spec operations (issue #638).
 *
 * The stakes are why this is exercised at the shape level and not only through
 * the tab: a wrong identity is worse than no identity, because #627's sync
 * applies changes *by* it - a request matched to the wrong operation would later
 * be rewritten from the wrong schema.
 */

import { describe, it, expect } from "vitest";
import { matchOperations, requestPathShape, specPathShape } from "./operation-match";
import type { Request, SpecOperation } from "@/types";

function request(id: string, method: string, url: string): Request {
	return {
		id,
		collectionId: "col_1",
		name: id,
		description: "",
		method: method as Request["method"],
		url,
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		stream: false,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

const op = (method: string, path: string, operationId?: string): SpecOperation => ({
	...(operationId ? { operationId } : {}),
	method,
	path,
});

describe("requestPathShape", () => {
	it("drops the origin, however the request states it", () => {
		// The three shapes a URL arrives in: the import's `{{baseUrl}}`, a written
		// absolute URL, and a schemeless host.
		expect(requestPathShape("{{baseUrl}}/pets")).toBe("/pets");
		expect(requestPathShape("https://api.example.com/pets")).toBe("/pets");
		expect(requestPathShape("api.example.com/pets")).toBe("/pets");
	});

	it("drops the query and the fragment", () => {
		expect(requestPathShape("{{baseUrl}}/pets?limit=10#top")).toBe("/pets");
	});

	it("flattens both template syntaxes to the same placeholder", () => {
		expect(requestPathShape("{{baseUrl}}/pets/{{petId}}/toys")).toBe("/pets/{}/toys");
		expect(specPathShape("/pets/{petId}/toys")).toBe("/pets/{}/toys");
		// A renamed path parameter is the same endpoint, so the names must not
		// enter the comparison.
		expect(specPathShape("/pets/{id}/toys")).toBe(specPathShape("/pets/{petId}/toys"));
	});

	it("treats a trailing slash as the same path, and keeps the root", () => {
		expect(requestPathShape("{{baseUrl}}/pets/")).toBe("/pets");
		expect(requestPathShape("{{baseUrl}}/")).toBe("/");
	});

	it("states no path for a URL that is only an origin", () => {
		// Defaulting to "/" here would match such a request against the spec's root
		// operation - a match nobody asked for.
		expect(requestPathShape("{{baseUrl}}")).toBeUndefined();
		expect(requestPathShape("")).toBeUndefined();
	});
});

describe("matchOperations", () => {
	it("pairs a request with its operation and reports both leftovers", () => {
		const requests = [
			request("r1", "GET", "{{baseUrl}}/pets"),
			request("r2", "GET", "{{baseUrl}}/pets/{{petId}}"),
			request("r3", "GET", "{{baseUrl}}/health"),
		];
		const operations = [
			op("GET", "/pets", "listPets"),
			op("GET", "/pets/{petId}", "getPet"),
			op("POST", "/pets", "createPet"),
		];

		const result = matchOperations(requests, operations);

		expect(result.matched.map((m) => [m.request.id, m.operation.operationId])).toEqual([
			["r1", "listPets"],
			["r2", "getPet"],
		]);
		expect(result.unmatchedRequests.map((r) => r.id)).toEqual(["r3"]);
		expect(result.unmatchedOperations.map((o) => o.operationId)).toEqual(["createPet"]);
	});

	it("does not match across methods", () => {
		const result = matchOperations(
			[request("r1", "DELETE", "{{baseUrl}}/pets/{{petId}}")],
			[op("GET", "/pets/{petId}", "getPet")]
		);
		expect(result.matched).toEqual([]);
		expect(result.unmatchedRequests.map((r) => r.id)).toEqual(["r1"]);
	});

	it("refuses an ambiguous shape rather than picking one", () => {
		// Two requests reduce to `GET /pets/{}`. Either could be the operation and
		// nothing here can tell which, so neither is stamped and both are reported.
		const requests = [
			request("r1", "GET", "{{baseUrl}}/pets/{{petId}}"),
			request("r2", "GET", "{{baseUrl}}/pets/{{id}}"),
		];

		const result = matchOperations(requests, [op("GET", "/pets/{petId}", "getPet")]);

		expect(result.matched).toEqual([]);
		expect(result.unmatchedRequests.map((r) => r.id)).toEqual(["r1", "r2"]);
		expect(result.unmatchedOperations.map((o) => o.operationId)).toEqual(["getPet"]);
	});

	it("matches a request that has the id written in", () => {
		// The hand-built case: nobody types `{{petId}}` into a collection they
		// built by hand, and without this pass binding such a collection would
		// match nothing at all.
		const result = matchOperations(
			[request("r1", "GET", "https://api.example.com/pets/42")],
			[op("GET", "/pets/{petId}", "getPet")]
		);

		expect(result.matched.map((m) => [m.request.id, m.operation.operationId])).toEqual([
			["r1", "getPet"],
		]);
	});

	it("prefers the literal path over the template that could also have filled it", () => {
		// OpenAPI's own precedence: `/pets/mine` is that operation, not an
		// instance of `/pets/{petId}`.
		const result = matchOperations(
			[request("r1", "GET", "{{baseUrl}}/pets/mine")],
			[op("GET", "/pets/{petId}", "getPet"), op("GET", "/pets/mine", "myPets")]
		);

		expect(result.matched.map((m) => m.operation.operationId)).toEqual(["myPets"]);
		expect(result.unmatchedOperations.map((o) => o.operationId)).toEqual(["getPet"]);
	});

	it("leaves a concrete request alone when two templates could claim it", () => {
		const result = matchOperations(
			[request("r1", "GET", "{{baseUrl}}/pets/42")],
			[op("GET", "/pets/{petId}", "getPet"), op("GET", "/pets/{id}", "getPetAlias")]
		);

		expect(result.matched).toEqual([]);
		expect(result.unmatchedRequests.map((r) => r.id)).toEqual(["r1"]);
	});

	it("never lets a placeholder swallow a path separator", () => {
		const result = matchOperations(
			[request("r1", "GET", "{{baseUrl}}/pets/42/toys")],
			[op("GET", "/pets/{petId}", "getPet")]
		);

		expect(result.matched).toEqual([]);
	});

	it("matches nothing when there is nothing to match", () => {
		expect(matchOperations([], [op("GET", "/pets")]).unmatchedOperations).toHaveLength(1);
		expect(matchOperations([request("r1", "GET", "{{baseUrl}}/pets")], []).matched).toEqual([]);
	});
});
