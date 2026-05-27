import { describe, it, expect } from "vitest";
import { sampleSchema } from "./schema-sampler";

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
});
