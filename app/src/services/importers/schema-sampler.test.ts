import { describe, it, expect } from "vitest";
import { sampleSchema, schemaFormFields } from "./schema-sampler";

/** The field names alone - what most of these cases are about. */
const names = (schema: unknown, resolve = resolver): string[] =>
	schemaFormFields(schema, resolve).map((f) => f.name);

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

describe("schemaFormFields", () => {
	it("resolves a $ref'd form schema to its property names", () => {
		expect(names({ $ref: "#/components/schemas/Pet" })).toEqual(["id", "name", "tags"]);
	});
	it("reads an inline schema's own properties, in order", () => {
		expect(
			names({ type: "object", properties: { grant_type: {}, username: {}, password: {} } })
		).toEqual(["grant_type", "username", "password"]);
	});
	it("follows the first allOf branch, as JSON bodies do", () => {
		expect(names({ allOf: [{ $ref: "#/components/schemas/Pet" }, {}] })).toEqual([
			"id",
			"name",
			"tags",
		]);
	});
	it("has no fields for a missing schema or one that samples to a non-object", () => {
		expect(schemaFormFields(undefined, resolver)).toEqual([]);
		expect(schemaFormFields({ type: "string" }, resolver)).toEqual([]);
		expect(schemaFormFields({ type: "array", items: { type: "string" } }, resolver)).toEqual(
			[]
		);
		expect(schemaFormFields({ example: "not an object" }, resolver)).toEqual([]);
	});

	it("marks a `format: binary` property as a file and leaves text fields alone", () => {
		expect(
			schemaFormFields(
				{
					type: "object",
					properties: {
						caption: { type: "string" },
						avatar: { type: "string", format: "binary" },
					},
				},
				resolver
			)
		).toEqual([
			{ name: "caption", file: false },
			{ name: "avatar", file: true },
		]);
	});

	it("marks an array of binary items as a file - one row for a multi-file field", () => {
		expect(
			schemaFormFields(
				{
					type: "object",
					properties: {
						pages: { type: "array", items: { type: "string", format: "binary" } },
						tags: { type: "array", items: { type: "string" } },
					},
				},
				resolver
			)
		).toEqual([
			{ name: "pages", file: true },
			{ name: "tags", file: false },
		]);
	});

	it("sees a binary property through a $ref and through the first allOf branch", () => {
		const resolve = (ref: string): unknown =>
			({
				"#/components/schemas/Upload": {
					type: "object",
					properties: { doc: { $ref: "#/components/schemas/Binary" } },
				},
				"#/components/schemas/Binary": { type: "string", format: "binary" },
			})[ref];
		expect(schemaFormFields({ $ref: "#/components/schemas/Upload" }, resolve)).toEqual([
			{ name: "doc", file: true },
		]);
		expect(
			schemaFormFields({ allOf: [{ $ref: "#/components/schemas/Upload" }] }, resolve)
		).toEqual([{ name: "doc", file: true }]);
	});

	it("reads no file out of an `example`, which carries no property schemas", () => {
		expect(schemaFormFields({ example: { avatar: "" } }, resolver)).toEqual([
			{ name: "avatar", file: false },
		]);
	});

	it("survives a cyclic $ref rather than recursing forever", () => {
		expect(schemaFormFields({ $ref: "#/components/schemas/Node" }, resolver)).toEqual([
			{ name: "next", file: false },
		]);
	});
});
