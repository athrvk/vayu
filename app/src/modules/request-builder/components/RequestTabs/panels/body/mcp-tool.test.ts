/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the MCP tool fields commit. The engine refuses a stored tool with a
 * blank name or a non-object schema and refuses the whole save for it, so the
 * fields commit only what it would take (#3762).
 */

import { describe, it, expect } from "vitest";
import {
	SCHEMA_NOT_AN_OBJECT,
	SCHEMA_WITHOUT_NAME,
	describes,
	fieldsOf,
	readFields,
} from "./mcp-tool";

const SCHEMA = { type: "object", properties: { region: { "x-mcp-header": "Region" } } };

describe("fieldsOf", () => {
	it("reads no tool as two empty fields", () => {
		expect(fieldsOf(undefined)).toEqual({ name: "", schema: "" });
	});

	it("indents a stored schema and keeps the name", () => {
		const fields = fieldsOf({ name: "t", inputSchema: SCHEMA });
		expect(fields.name).toBe("t");
		expect(JSON.parse(fields.schema)).toEqual(SCHEMA);
		expect(fields.schema).toContain("\n");
	});

	it("leaves the schema blank for a tool that states none", () => {
		expect(fieldsOf({ name: "t" })).toEqual({ name: "t", schema: "" });
	});
});

describe("readFields", () => {
	it("commits nothing for empty fields, without complaint", () => {
		expect(readFields({ name: "", schema: "" })).toEqual({
			tool: undefined,
			nameError: null,
			schemaError: null,
		});
	});

	it("commits a name alone, trimmed, with no schema key", () => {
		const { tool } = readFields({ name: "  t ", schema: " " });
		expect(tool).toEqual({ name: "t" });
		expect(tool).not.toHaveProperty("inputSchema");
	});

	it("commits a name with its parsed schema", () => {
		expect(readFields({ name: "t", schema: JSON.stringify(SCHEMA) }).tool).toEqual({
			name: "t",
			inputSchema: SCHEMA,
		});
	});

	it("refuses a schema with no name, and says why", () => {
		expect(readFields({ name: " ", schema: "{}" })).toEqual({
			tool: undefined,
			nameError: SCHEMA_WITHOUT_NAME,
			schemaError: null,
		});
	});

	it.each(["{", "[]", "3", '"s"', "null"])("refuses %s as a schema", (schema) => {
		expect(readFields({ name: "t", schema })).toEqual({
			tool: undefined,
			nameError: null,
			schemaError: SCHEMA_NOT_AN_OBJECT,
		});
	});
});

describe("describes", () => {
	it("is true for the fields a tool was read from", () => {
		const tool = { name: "t", inputSchema: SCHEMA };
		expect(describes(fieldsOf(tool), tool)).toBe(true);
		expect(describes(fieldsOf(undefined), undefined)).toBe(true);
	});

	it("is false when the stored tool moved under the fields", () => {
		expect(describes(fieldsOf({ name: "a" }), { name: "b" })).toBe(false);
		expect(describes(fieldsOf({ name: "a" }), undefined)).toBe(false);
	});

	it("ignores the order a stored schema's members come back in", () => {
		const typed = { name: "t", schema: JSON.stringify(SCHEMA) };
		const reordered = {
			inputSchema: { properties: { region: { "x-mcp-header": "Region" } }, type: "object" },
			name: "t",
		};
		expect(describes(typed, reordered)).toBe(true);
		expect(
			describes(typed, { name: "t", inputSchema: { type: "object", properties: {} } })
		).toBe(false);
	});

	it("holds a stored tool through half-typed JSON", () => {
		expect(describes({ name: "t", schema: '{"type":' }, { name: "t" })).toBe(true);
	});

	it("treats a schema stranded without a name as storing no tool", () => {
		expect(describes({ name: "", schema: "{}" }, undefined)).toBe(true);
		expect(describes({ name: "", schema: "{}" }, { name: "t" })).toBe(false);
	});
});
