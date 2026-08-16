/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Extracting and translating declared response schemas (issue #628).
 *
 * The translation cases are the ones worth locking: each of them is a place
 * where passing OpenAPI's dialect through untouched produces a *wrong* verdict
 * rather than a missing one - a null the document permits reported as a type
 * failure, a bound that means the opposite of what it says.
 */

import { describe, expect, it } from "vitest";

import {
	buildResponseSchemaIndex,
	refRootsOf,
	responseSchemasV2,
	responseSchemasV3,
	toJsonSchema,
} from "./response-schemas";

describe("toJsonSchema", () => {
	it("turns `nullable` into a union with null", () => {
		// Revert this and a document that says "a string, or null" starts
		// reporting every null it explicitly permits as a type failure.
		expect(toJsonSchema({ type: "string", nullable: true })).toEqual({
			type: ["string", "null"],
		});
		expect(toJsonSchema({ type: ["string", "null"], nullable: true })).toEqual({
			type: ["string", "null"],
		});
	});

	it("leaves a nullable with no type alone", () => {
		// No `type` means every JSON value was already allowed, null included.
		expect(toJsonSchema({ nullable: true, description: "anything" })).toEqual({
			description: "anything",
		});
	});

	it("translates draft-04 boolean exclusive bounds into draft-07 values", () => {
		expect(toJsonSchema({ type: "integer", minimum: 5, exclusiveMinimum: true })).toEqual({
			type: "integer",
			minimum: 5,
			exclusiveMinimum: 5,
		});
		// `false` says the bound is inclusive, which draft-07 spells by simply
		// not having the keyword.
		expect(toJsonSchema({ type: "integer", minimum: 5, exclusiveMinimum: false })).toEqual({
			type: "integer",
			minimum: 5,
		});
		// draft-07's own numeric form is already right and must survive.
		expect(toJsonSchema({ type: "integer", exclusiveMinimum: 5 })).toEqual({
			type: "integer",
			exclusiveMinimum: 5,
		});
	});

	it("drops OpenAPI's own vocabulary", () => {
		expect(
			toJsonSchema({
				type: "object",
				discriminator: { propertyName: "kind" },
				xml: { name: "pet" },
				example: { id: 1 },
				externalDocs: { url: "https://example.com" },
			})
		).toEqual({ type: "object" });
	});

	it("translates through every subschema position", () => {
		expect(
			toJsonSchema({
				type: "object",
				properties: { a: { type: "string", nullable: true } },
				items: { type: "integer", nullable: true },
				allOf: [{ type: "string", nullable: true }],
				not: { type: "boolean", nullable: true },
			})
		).toEqual({
			type: "object",
			properties: { a: { type: ["string", "null"] } },
			items: { type: ["integer", "null"] },
			allOf: [{ type: ["string", "null"] }],
			not: { type: ["boolean", "null"] },
		});
	});

	it("keeps a `$ref` as written rather than following it", () => {
		// Following it here is what makes a recursive schema infinite; the
		// engine resolves pointers against the shared roots instead.
		expect(toJsonSchema({ $ref: "#/components/schemas/Pet" })).toEqual({
			$ref: "#/components/schemas/Pet",
		});
	});

	it("carries boolean schemas through", () => {
		expect(toJsonSchema(true)).toBe(true);
		expect(toJsonSchema(false)).toBe(false);
	});

	it("does not treat a property named like a keyword as a keyword", () => {
		// `properties` holds data names. A body field called "nullable" is a
		// field, not a dialect instruction.
		expect(
			toJsonSchema({ type: "object", properties: { nullable: { type: "boolean" } } })
		).toEqual({ type: "object", properties: { nullable: { type: "boolean" } } });
	});
});

describe("responseSchemasV3", () => {
	const operation = {
		responses: {
			"200": {
				content: {
					"application/json": { schema: { type: "object", nullable: true } },
					"application/xml": { schema: { type: "string" } },
				},
			},
			"4XX": { content: { "application/json": { schema: { type: "object" } } } },
			"304": { description: "not modified" }, // no content - nothing to check
		},
	};

	it("keeps every media type, translated, with the status pattern verbatim", () => {
		expect(responseSchemasV3(operation)).toEqual([
			{
				status: "200",
				contentType: "application/json",
				schema: { type: ["object", "null"] },
			},
			{ status: "200", contentType: "application/xml", schema: { type: "string" } },
			{ status: "4XX", contentType: "application/json", schema: { type: "object" } },
		]);
	});

	it("skips a response that declares no schema", () => {
		// An absent schema is not an empty one: `{}` would validate everything
		// and report a body as matching a contract that never described it.
		expect(
			responseSchemasV3({ responses: { "200": { content: { "text/plain": {} } } } })
		).toEqual([]);
	});

	it("is empty for an operation with no responses", () => {
		expect(responseSchemasV3({})).toEqual([]);
	});
});

describe("responseSchemasV2", () => {
	it("pairs each response schema with the operation's produced media types", () => {
		const declared = responseSchemasV2(
			{
				produces: ["application/json", "application/xml"],
				responses: { "200": { schema: { type: "object" } } },
			},
			{}
		);
		expect(declared).toEqual([
			{ status: "200", contentType: "application/json", schema: { type: "object" } },
			{ status: "200", contentType: "application/xml", schema: { type: "object" } },
		]);
	});

	it("falls back to the document's produces, then to JSON", () => {
		expect(
			responseSchemasV2(
				{ responses: { "200": { schema: { type: "object" } } } },
				{
					produces: ["application/hal+json"],
				}
			)
		).toEqual([
			{ status: "200", contentType: "application/hal+json", schema: { type: "object" } },
		]);
		expect(
			responseSchemasV2({ responses: { "200": { schema: { type: "object" } } } }, {})
		).toEqual([{ status: "200", contentType: "application/json", schema: { type: "object" } }]);
	});
});

describe("refRootsOf", () => {
	it("carries the subtrees a `$ref` can point into, translated", () => {
		expect(
			refRootsOf({
				components: { schemas: { Pet: { type: "object", nullable: true } } },
				paths: {},
			})
		).toEqual({ components: { schemas: { Pet: { type: ["object", "null"] } } } });
	});

	it("carries Swagger definitions and the bundler's inlined files", () => {
		const roots = refRootsOf({
			definitions: { Pet: { type: "object", nullable: true } },
			"x-vayu-bundled": {
				// A bundled file that is itself a schema document.
				"schemas-pet-yaml": { type: "object", nullable: true },
				// And one that carries its own components, reached by a ref of
				// the form `#/x-vayu-bundled/<slug>/components/schemas/Tag`.
				"common-yaml": {
					components: { schemas: { Tag: { type: "string", nullable: true } } },
				},
			},
		});
		expect(roots).toEqual({
			definitions: { Pet: { type: ["object", "null"] } },
			"x-vayu-bundled": {
				"schemas-pet-yaml": { type: ["object", "null"] },
				"common-yaml": { components: { schemas: { Tag: { type: ["string", "null"] } } } },
			},
		});
	});

	it("is undefined for a document with none", () => {
		expect(refRootsOf({ paths: {} })).toBeUndefined();
	});
});

describe("buildResponseSchemaIndex", () => {
	const identity = { method: "GET", path: "/pets", operationId: "listPets" };

	it("indexes only the operations that declare something", () => {
		const index = buildResponseSchemaIndex({ components: { schemas: {} } }, [
			{
				identity,
				responses: [
					{ status: "200", contentType: "application/json", schema: { type: "object" } },
				],
			},
			{ identity: { method: "POST", path: "/pets" }, responses: [] },
		]);
		expect(index?.operations).toHaveLength(1);
		expect(index?.operations[0]).toMatchObject({ method: "GET", path: "/pets" });
	});

	it("is undefined when nothing declares a schema", () => {
		// "No index" and "declares nothing" are stored the same way, and the
		// honest reading of a document nothing was extracted from is the first.
		expect(buildResponseSchemaIndex({}, [{ identity, responses: [] }])).toBeUndefined();
	});
});
