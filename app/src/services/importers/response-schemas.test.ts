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

import { createRefResolver } from "./openapi-shared";
import {
	buildResponseSchemaIndex,
	refRootsOf,
	responseSchemasV2,
	responseSchemasV3,
	toJsonSchema,
} from "./response-schemas";

/** A document that declares nothing to resolve, for the ref-free cases. */
const noRefs = createRefResolver({});

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
		expect(responseSchemasV3(operation, noRefs)).toEqual([
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
			responseSchemasV3({ responses: { "200": { content: { "text/plain": {} } } } }, noRefs)
		).toEqual([]);
	});

	it("is empty for an operation with no responses", () => {
		expect(responseSchemasV3({}, noRefs)).toEqual([]);
	});

	describe("a response that is itself a `$ref` (issue #714)", () => {
		// GitHub's public spec declares nearly every response this way. Read
		// unresolved, the `$ref` node has no `content`, so nothing is extracted
		// and the engine reports "the spec declares no response for this status"
		// about a status the document declares plainly.
		const components = {
			responses: {
				not_found: {
					description: "Resource not found",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/basic_error" },
						},
					},
				},
				validation_failed: {
					description: "Validation failed",
					content: { "application/json": { schema: { type: "object", nullable: true } } },
				},
			},
			schemas: { basic_error: { type: "object" } },
		};
		const resolveRef = createRefResolver({ components });

		it("extracts exactly what the inline-equivalent document would", () => {
			// The pair, side by side: same document, one written through
			// components, one written out. Revert the deref and the first side
			// goes empty while the second stays full.
			const viaRef = responseSchemasV3(
				{
					responses: {
						"404": { $ref: "#/components/responses/not_found" },
						"422": { $ref: "#/components/responses/validation_failed" },
					},
				},
				resolveRef
			);
			const inline = responseSchemasV3(
				{
					responses: {
						"404": components.responses.not_found,
						"422": components.responses.validation_failed,
					},
				},
				resolveRef
			);
			expect(viaRef).toEqual(inline);
			expect(viaRef).toEqual([
				{
					status: "404",
					contentType: "application/json",
					// A schema `$ref` inside the resolved response is still kept as
					// written - `refRoots` carries `components.schemas`, which is
					// what it points into.
					schema: { $ref: "#/components/schemas/basic_error" },
				},
				{
					status: "422",
					contentType: "application/json",
					schema: { type: ["object", "null"] },
				},
			]);
		});

		it("extracts both halves of an operation mixing inline and `$ref` responses", () => {
			expect(
				responseSchemasV3(
					{
						responses: {
							"200": {
								content: { "application/json": { schema: { type: "array" } } },
							},
							"404": { $ref: "#/components/responses/not_found" },
						},
					},
					resolveRef
				)
			).toEqual([
				{ status: "200", contentType: "application/json", schema: { type: "array" } },
				{
					status: "404",
					contentType: "application/json",
					schema: { $ref: "#/components/schemas/basic_error" },
				},
			]);
		});

		it("steps over a `$ref` to a component that does not exist", () => {
			// Nothing to extract and nothing to throw: the entry is simply not in
			// the index, which reads as "not checked" rather than as a pass.
			expect(
				responseSchemasV3(
					{
						responses: {
							"404": { $ref: "#/components/responses/gone_missing" },
							"200": {
								content: { "application/json": { schema: { type: "array" } } },
							},
						},
					},
					resolveRef
				)
			).toEqual([
				{ status: "200", contentType: "application/json", schema: { type: "array" } },
			]);
		});
	});
});

describe("responseSchemasV2", () => {
	it("pairs each response schema with the operation's produced media types", () => {
		const declared = responseSchemasV2(
			{
				produces: ["application/json", "application/xml"],
				responses: { "200": { schema: { type: "object" } } },
			},
			{},
			noRefs
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
				},
				noRefs
			)
		).toEqual([
			{ status: "200", contentType: "application/hal+json", schema: { type: "object" } },
		]);
		expect(
			responseSchemasV2({ responses: { "200": { schema: { type: "object" } } } }, {}, noRefs)
		).toEqual([{ status: "200", contentType: "application/json", schema: { type: "object" } }]);
	});

	it("follows a 2.0 response `$ref` into the document's `responses` container", () => {
		// 2.0 spells the same shape one level shallower: `#/responses/X`, not
		// `#/components/responses/X`. Revert the deref and this goes empty.
		const spec = {
			responses: {
				NotFound: { description: "gone", schema: { $ref: "#/definitions/Error" } },
			},
			definitions: { Error: { type: "object" } },
		};
		expect(
			responseSchemasV2(
				{ responses: { "404": { $ref: "#/responses/NotFound" } } },
				spec,
				createRefResolver(spec)
			)
		).toEqual([
			{
				status: "404",
				contentType: "application/json",
				schema: { $ref: "#/definitions/Error" },
			},
		]);
	});

	it("steps over a 2.0 `$ref` to a response that does not exist", () => {
		const spec = { responses: {} };
		expect(
			responseSchemasV2(
				{ responses: { "404": { $ref: "#/responses/NotFound" } } },
				spec,
				createRefResolver(spec)
			)
		).toEqual([]);
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
