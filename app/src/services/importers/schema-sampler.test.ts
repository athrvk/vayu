import { describe, it, expect } from "vitest";
import { sampleSchema, schemaFieldNames } from "./schema-sampler";

const resolver = (ref: string): unknown =>
	({
		"#/components/schemas/Pet": {
			type: "object",
			properties: {
				id: { type: "integer" },
				name: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
			},
		},
		"#/components/schemas/Node": {
			type: "object",
			properties: { next: { $ref: "#/components/schemas/Node" } }, // cyclic
		},
	})[ref];

describe("sampleSchema", () => {
	it("prefers an explicit example", () => {
		expect(sampleSchema({ type: "string", example: "hi" }, resolver)).toBe("hi");
	});
	it("uses enum[0] for strings without example", () => {
		expect(sampleSchema({ type: "string", enum: ["a", "b"] }, resolver)).toBe("a");
	});
	it("produces typed defaults", () => {
		expect(sampleSchema({ type: "integer" }, resolver)).toBe(0);
		expect(sampleSchema({ type: "boolean" }, resolver)).toBe(false);
		expect(sampleSchema({ type: "array", items: { type: "string" } }, resolver)).toEqual([""]);
	});
	it("walks objects and resolves $ref", () => {
		expect(sampleSchema({ $ref: "#/components/schemas/Pet" }, resolver)).toEqual({
			id: 0,
			name: "",
			tags: [""],
		});
	});
	it("picks the first branch for allOf/oneOf/anyOf", () => {
		expect(sampleSchema({ oneOf: [{ type: "string" }, { type: "integer" }] }, resolver)).toBe(
			""
		);
	});
	it("stops at the depth cap / cycle without infinite recursion", () => {
		const v = sampleSchema({ $ref: "#/components/schemas/Node" }, resolver);
		expect(v).toEqual({ next: {} }); // first level resolves; the self-$ref collapses to {}
	});

	// OpenAPI 3.1 keywords - the detector matches 3.1.x, so the sampler has to as well.
	it("samples a 3.1 type array using its first non-null member", () => {
		expect(sampleSchema({ type: ["string", "null"] }, resolver)).toBe("");
		expect(sampleSchema({ type: ["null", "integer"] }, resolver)).toBe(0);
		expect(
			sampleSchema(
				{ type: ["object", "null"], properties: { a: { type: "boolean" } } },
				resolver
			)
		).toEqual({ a: false });
	});
	it("samples an only-null type as null", () => {
		expect(sampleSchema({ type: ["null"] }, resolver)).toBe(null);
		expect(sampleSchema({ type: "null" }, resolver)).toBe(null);
	});
	it("returns const verbatim, outranking example", () => {
		expect(sampleSchema({ type: "string", const: "fixed" }, resolver)).toBe("fixed");
		expect(sampleSchema({ const: "fixed", example: "annotation" }, resolver)).toBe("fixed");
		expect(sampleSchema({ type: "string", const: null }, resolver)).toBe(null);
	});
	it("falls back to examples[0] when there is no singular example", () => {
		expect(sampleSchema({ type: "string", examples: ["first", "second"] }, resolver)).toBe(
			"first"
		);
		expect(sampleSchema({ example: "singular", examples: ["array"] }, resolver)).toBe(
			"singular"
		);
		expect(sampleSchema({ type: "string", examples: [] }, resolver)).toBe("");
	});
});

describe("schemaFieldNames", () => {
	it("resolves a $ref'd form schema to its property names", () => {
		expect(schemaFieldNames({ $ref: "#/components/schemas/Pet" }, resolver)).toEqual([
			"id",
			"name",
			"tags",
		]);
	});
	it("reads an inline schema's own properties, in order", () => {
		expect(
			schemaFieldNames(
				{ type: "object", properties: { grant_type: {}, username: {}, password: {} } },
				resolver
			)
		).toEqual(["grant_type", "username", "password"]);
	});
	it("follows the first allOf branch, as JSON bodies do", () => {
		expect(
			schemaFieldNames({ allOf: [{ $ref: "#/components/schemas/Pet" }, {}] }, resolver)
		).toEqual(["id", "name", "tags"]);
	});
	it("has no field names for a missing schema or one that samples to a non-object", () => {
		expect(schemaFieldNames(undefined, resolver)).toEqual([]);
		expect(schemaFieldNames({ type: "string" }, resolver)).toEqual([]);
		expect(schemaFieldNames({ type: "array", items: { type: "string" } }, resolver)).toEqual(
			[]
		);
		expect(schemaFieldNames({ example: "not an object" }, resolver)).toEqual([]);
	});
});
