/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Exporting a collection as an OpenAPI document (issue #630).
 *
 * Two directions with opposite failure modes, so both are exercised here. A
 * bound export's danger is *loss* - a member of the user's own contract that
 * export quietly drops - which is why preservation is asserted by perturbing the
 * stored document and reading the perturbation back out. A skeleton's danger is
 * *invention* - a schema, a required flag or a response nobody declared - which
 * is why the assertions are as much about what is absent as about what is there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, it, expect } from "vitest";

import { exportOpenApi, SpecDocumentError, type ExportRequest } from "./openapi";
import { readSpecOperations } from "@/services/openapi/spec-operations";
import type { Collection, KeyValueEntry, Request, RequestBody, RequestExample } from "@/types";

const bound = readFileSync(join(__dirname, "__fixtures__/petstore-bound.json"), "utf8");

function collection(overrides: Partial<Collection> = {}): Collection {
	return {
		id: "col_1",
		name: "Petstore",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function request(overrides: Partial<Request> = {}): Request {
	return {
		id: "req_1",
		collectionId: "col_1",
		name: "",
		description: "",
		method: "GET",
		url: "{{baseUrl}}/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		verifySSL: true,
		httpVersion: "auto",
		stream: false,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function example(overrides: Partial<RequestExample> = {}): RequestExample {
	return {
		id: "ex_1",
		name: "200 - ok",
		status: 200,
		headers: [],
		body: '{"id":"p1","name":"Rex"}',
		contentType: "application/json",
		origin: "import",
		...overrides,
	};
}

function entry(req: Partial<Request>, examples: RequestExample[] = []): ExportRequest {
	return { request: request(req), examples };
}

/** The three bound requests the fixture describes, all identities intact. */
function boundRequests(): ExportRequest[] {
	return [
		entry({
			id: "req_list",
			name: "List pets",
			url: "{{baseUrl}}/pets",
			specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
		}),
		entry({
			id: "req_create",
			method: "POST",
			url: "{{baseUrl}}/pets",
			specOperation: { operationId: "createPet", method: "POST", path: "/pets" },
		}),
		entry({
			id: "req_delete",
			method: "DELETE",
			url: "{{baseUrl}}/pets/{{petId}}",
			specOperation: { operationId: "deletePet", method: "DELETE", path: "/pets/{petId}" },
		}),
	];
}

function exportJson(input: {
	requests: ExportRequest[];
	specContent?: string;
	collection?: Collection;
}) {
	const result = exportOpenApi({
		collection: input.collection ?? collection(),
		requests: input.requests,
		...(input.specContent === undefined ? {} : { specContent: input.specContent }),
		format: "json",
	});
	return { ...result, document: JSON.parse(result.text) as Record<string, never> };
}

describe("bound export - the document, updated", () => {
	it("keeps every member Vayu does not model, including one nothing references", () => {
		const { document } = exportJson({ requests: boundRequests(), specContent: bound });
		const stored = JSON.parse(bound);

		expect(document["x-vendor-note"]).toBe(stored["x-vendor-note"]);
		expect(document["info"]).toEqual(stored.info);
		expect(document["tags"]).toEqual(stored.tags);
		expect(document["servers"]).toEqual(stored.servers);
		expect(document["components"]).toEqual(stored.components);
		// The dialect is the stored one - a 3.0 document does not export as 3.1.
		expect(document["openapi"]).toBe("3.0.3");
	});

	it("carries a perturbed member through rather than regenerating the document", () => {
		// The mutation check for preservation: change something in the stored
		// document that Vayu has no concept of, and it must appear in the output.
		// A rebuilt-from-scratch exporter passes the assertions above by luck and
		// fails this one.
		const perturbed = JSON.parse(bound);
		perturbed["x-vendor-note"] = "perturbed";
		perturbed.components.schemas.Unused.description = "still here";

		const { document } = exportJson({
			requests: boundRequests(),
			specContent: JSON.stringify(perturbed),
		});
		expect(document["x-vendor-note"]).toBe("perturbed");
		expect(
			(document["components"] as { schemas: { Unused: { description: string } } }).schemas
				.Unused.description
		).toBe("still here");
	});

	it("removes an operation no request claims, and the path it emptied", () => {
		const requests = boundRequests().filter((e) => e.request.id !== "req_delete");
		const { document, notes } = exportJson({ requests, specContent: bound });

		const paths = document["paths"] as Record<string, unknown>;
		expect(Object.keys(paths)).toEqual(["/pets"]);
		expect(notes.operationsRemoved).toBe(1);
		expect(notes.requestsExported).toBe(2);
	});

	it("re-imports to the same operations it exported", () => {
		// The round-trip invariant: what comes back out of a bound export is the
		// same set of identities that went in. #627's diff is the verifier this
		// will use once sync lands; until then the identities the importers
		// themselves read are the honest check, and they are the same values a
		// diff would compare.
		const requests = boundRequests();
		const { text } = exportJson({ requests, specContent: bound });

		// As a set: a re-import reads the document in *document* order and files
		// requests under their tags, so the sequence is the document's business,
		// not the export's. What must hold is that every identity survived and
		// none was invented.
		const key = (o: { method: string; path: string } | undefined) => `${o?.method} ${o?.path}`;
		const reimported = readSpecOperations(text).operations;
		expect(reimported.map(key).sort()).toEqual(
			requests.map((e) => key(e.request.specOperation)).sort()
		);
		expect(reimported.map((o) => o.operationId).sort()).toEqual([
			"createPet",
			"deletePet",
			"listPets",
		]);
	});

	it("writes one stored example as `example`, and several as a named map", () => {
		const requests = boundRequests();
		requests[0].examples = [example()];
		requests[1].examples = [
			example({ id: "ex_a", name: "created", status: 201, body: '{"id":"p1"}' }),
			example({ id: "ex_b", name: "created twin", status: 201, body: '{"id":"p2"}' }),
		];
		const { document, notes } = exportJson({ requests, specContent: bound });

		const pets = (document["paths"] as Record<string, Record<string, never>>)["/pets"];
		const listJson = media(pets, "get", "200");
		expect(listJson.example).toEqual({ id: "p1", name: "Rex" });
		// The declared schema is the contract's; an example never replaces it.
		expect(listJson.schema).toEqual({ $ref: "#/components/schemas/Pet" });
		expect(listJson.examples).toBeUndefined();

		const createJson = media(pets, "post", "201");
		expect(createJson.example).toBeUndefined();
		expect(createJson.examples).toEqual({
			created: { value: { id: "p1" } },
			"created twin": { value: { id: "p2" } },
		});
		expect(notes.examplesWritten).toBe(3);
	});

	it("documents a status the spec never declared, and says when a body had no media type", () => {
		const requests = boundRequests();
		requests[0].examples = [
			example({
				id: "ex_404",
				name: "404 - missing",
				status: 404,
				body: "not found",
				contentType: "",
			}),
		];
		const { document, notes } = exportJson({ requests, specContent: bound });

		const response = (
			(document["paths"] as Record<string, Record<string, never>>)["/pets"]["get"] as {
				responses: Record<string, { description: string; content?: unknown }>;
			}
		).responses["404"];
		expect(response.description).toBe("404 - missing");
		// No `content`: there is no honest key for a body whose media type nobody
		// stated, and the count is what says the body was left out.
		expect(response.content).toBeUndefined();
		expect(notes.examplesWithoutMediaType).toBe(1);
		expect(notes.examplesWritten).toBe(0);
	});

	it("writes a request's parameter value as the declared parameter's example, and leaves a $ref alone", () => {
		const requests = boundRequests();
		requests[0].request = request({
			...requests[0].request,
			params: [row("limit", "25"), row("unknownToTheSpec", "9")],
		});
		const { document, notes } = exportJson({ requests, specContent: bound });

		const parameters = (
			(document["paths"] as Record<string, Record<string, never>>)["/pets"]["get"] as {
				parameters: Array<Record<string, unknown>>;
			}
		).parameters;
		expect(parameters[0]).toMatchObject({ name: "limit", example: "25" });
		// A parameter the request carries and the document does not declare is not
		// invented into the contract.
		expect(parameters).toHaveLength(2);
		expect(parameters[1]).toEqual({ $ref: "#/components/parameters/TraceId" });
		expect(notes.sharedParametersLeft).toBe(1);
	});

	it("never adds an operation for a request the contract does not describe", () => {
		const requests = [
			...boundRequests(),
			entry({ id: "req_free", method: "GET", url: "{{baseUrl}}/health" }),
			entry({
				id: "req_stale",
				method: "GET",
				url: "{{baseUrl}}/owners",
				specOperation: { method: "GET", path: "/owners" },
			}),
		];
		const { document, notes } = exportJson({ requests, specContent: bound });

		expect(Object.keys(document["paths"] as Record<string, unknown>)).toEqual([
			"/pets",
			"/pets/{petId}",
		]);
		expect(notes.requestsWithoutOperation).toBe(1);
		expect(notes.operationsNotInDocument).toBe(1);
		expect(notes.requestsExported).toBe(3);
	});

	it("removes from a Swagger 2.0 document but writes nothing into it", () => {
		const swagger = JSON.stringify({
			swagger: "2.0",
			info: { title: "Legacy", version: "1.0" },
			paths: {
				"/pets": {
					get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
					post: { operationId: "createPet", responses: { "200": { description: "ok" } } },
				},
			},
		});
		const requests = [
			entry(
				{
					id: "req_list",
					specOperation: { operationId: "listPets", method: "GET", path: "/pets" },
				},
				[example()]
			),
		];
		const { document, notes } = exportJson({ requests, specContent: swagger });

		const get = (document["paths"] as Record<string, Record<string, never>>)["/pets"][
			"get"
		] as {
			responses: Record<string, { examples?: unknown; content?: unknown }>;
		};
		expect(
			(document["paths"] as Record<string, Record<string, unknown>>)["/pets"]["post"]
		).toBeUndefined();
		expect(get.responses["200"].content).toBeUndefined();
		expect(get.responses["200"].examples).toBeUndefined();
		expect(notes.vocabularyNotWritten).toBe(true);
		expect(notes.dialect).toBe("Swagger 2.0");
		expect(notes.examplesWritten).toBe(0);
	});

	it("fails loudly on a stored document it cannot read", () => {
		expect(() =>
			exportJson({ requests: boundRequests(), specContent: "{ not json: [" })
		).toThrow(SpecDocumentError);
		expect(() => exportJson({ requests: boundRequests(), specContent: "[]" })).toThrow(
			SpecDocumentError
		);
		// Readable, but not a document Vayu can claim to be updating.
		expect(() =>
			exportJson({ requests: boundRequests(), specContent: '{"paths":{}}' })
		).toThrow(SpecDocumentError);
	});
});

describe("skeleton export - a starting point, not a contract", () => {
	it("recovers the path template and the server from the request URLs", () => {
		const { document, notes } = exportJson({
			requests: [
				entry({ id: "r1", method: "GET", url: "{{baseUrl}}/pets/{{petId}}?verbose=1" }),
				entry({ id: "r2", method: "POST", url: "{{baseUrl}}/pets" }),
			],
		});

		expect(document["openapi"]).toBe("3.1.0");
		expect(document["servers"]).toEqual([{ url: "{{baseUrl}}" }]);
		expect(Object.keys(document["paths"] as Record<string, unknown>)).toEqual([
			"/pets/{petId}",
			"/pets",
		]);
		const operation = (document["paths"] as Record<string, Record<string, never>>)[
			"/pets/{petId}"
		]["get"] as { parameters: Array<Record<string, unknown>> };
		expect(operation.parameters[0]).toEqual({
			name: "petId",
			in: "path",
			required: true,
			schema: { type: "string" },
		});
		expect(notes.direction).toBe("skeleton");
		expect(notes.requestsExported).toBe(2);
	});

	it("declares the rows the request holds without claiming any of them are required", () => {
		const { document } = exportJson({
			requests: [
				entry({
					id: "r1",
					params: [row("status", "available"), { ...row("verbose", ""), enabled: false }],
					headers: [row("Authorization", "Bearer x"), row("X-Tenant", "acme")],
				}),
			],
		});

		const parameters = operationOf(document, "/pets", "get").parameters as Array<
			Record<string, unknown>
		>;
		expect(parameters).toEqual([
			{ name: "status", in: "query", schema: { type: "string" }, example: "available" },
			// The disabled row survives - the endpoint accepts it either way - and
			// carries no `required`, because a toggle is not the API's demand.
			{ name: "verbose", in: "query", schema: { type: "string" } },
			{ name: "X-Tenant", in: "header", schema: { type: "string" }, example: "acme" },
		]);
	});

	it("describes a body only from the body that is there, and marks the shape as derived", () => {
		const { document } = exportJson({
			requests: [
				entry({
					id: "r1",
					method: "POST",
					url: "{{baseUrl}}/pets",
					body: json('{"name":"Rex","tags":["good"],"age":3}'),
					bodyType: "json",
				}),
				entry({ id: "r2", method: "PUT", url: "{{baseUrl}}/pets" }),
			],
		});

		const post = operationOf(document, "/pets", "post");
		const body = (post.requestBody as { content: Record<string, Record<string, never>> })
			.content["application/json"];
		expect(body.example).toEqual({ name: "Rex", tags: ["good"], age: 3 });
		expect(body.schema).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				age: { type: "integer" },
			},
			description: "Shape derived from an example body, not a declared schema.",
		});
		// No body, no `requestBody` - and no `responses`, because nothing was ever
		// saved to say what this endpoint answers.
		expect(operationOf(document, "/pets", "put").requestBody).toBeUndefined();
		expect(operationOf(document, "/pets", "put").responses).toBeUndefined();
	});

	it("writes responses from stored examples and nothing else", () => {
		const { document, notes } = exportJson({
			requests: [
				entry({ id: "r1" }, [
					example(),
					example({
						id: "ex_500",
						name: "500 - boom",
						status: 500,
						body: "boom",
						contentType: "text/plain",
					}),
				]),
			],
		});

		const responses = operationOf(document, "/pets", "get").responses as Record<
			string,
			{ description: string; content: Record<string, Record<string, never>> }
		>;
		expect(Object.keys(responses)).toEqual(["200", "500"]);
		expect(responses["200"].description).toBe("200 - ok");
		expect(responses["200"].content["application/json"].example).toEqual({
			id: "p1",
			name: "Rex",
		});
		// A body that is not JSON is the text it is, never dropped.
		expect(responses["500"].content["text/plain"].example).toBe("boom");
		expect(notes.examplesWritten).toBe(2);
	});

	it("counts a request it cannot place instead of guessing at one", () => {
		const { document, notes } = exportJson({
			requests: [
				entry({ id: "r1", url: "{{baseUrl}}" }),
				entry({ id: "r2", url: "{{baseUrl}}/pets" }),
				entry({ id: "r3", url: "https://api.example.com/pets" }),
			],
		});

		expect(Object.keys(document["paths"] as Record<string, unknown>)).toEqual(["/pets"]);
		expect(notes.requestsWithoutPath).toBe(1);
		expect(notes.duplicateOperations).toBe(1);
		expect(notes.requestsExported).toBe(1);
	});

	it("names the collection and never invents a version it was told", () => {
		const { document } = exportJson({
			requests: [],
			collection: collection({ name: "Internal tools", description: "Scratch space" }),
		});
		expect(document["info"]).toEqual({
			title: "Internal tools",
			version: "0.0.0",
			description: "Scratch space",
		});
		expect(document["servers"]).toBeUndefined();
	});
});

describe("serialization", () => {
	it("writes the same document as JSON and as YAML", () => {
		const requests = boundRequests();
		requests[0].examples = [example()];
		const input = {
			collection: collection(),
			requests,
			specContent: bound,
			format: "json" as const,
		};
		const asJson = exportOpenApi(input);
		const asYaml = exportOpenApi({ ...input, format: "yaml" });

		expect(yaml.load(asYaml.text)).toEqual(JSON.parse(asJson.text));
		expect(asJson.fileName).toBe("petstore.openapi.json");
		expect(asYaml.fileName).toBe("petstore.openapi.yaml");
	});

	it("names the file after the collection, however the collection is named", () => {
		const named = (name: string) =>
			exportOpenApi({ collection: collection({ name }), requests: [], format: "json" })
				.fileName;
		expect(named("Pet Store / v2")).toBe("pet-store-v2.openapi.json");
		expect(named("   ")).toBe("collection.openapi.json");
	});
});

function row(key: string, value: string): KeyValueEntry {
	return { key, value, enabled: true };
}

function json(content: string): RequestBody {
	return { mode: "json", content };
}

function operationOf(
	document: Record<string, never>,
	path: string,
	method: string
): Record<string, unknown> {
	return (document["paths"] as unknown as Record<string, Record<string, unknown>>)[path][
		method
	] as Record<string, unknown>;
}

function media(
	pathItem: Record<string, never>,
	method: string,
	status: string
): Record<string, unknown> {
	const operation = pathItem[method] as unknown as {
		responses: Record<string, { content: Record<string, Record<string, unknown>> }>;
	};
	return operation.responses[status].content["application/json"];
}
