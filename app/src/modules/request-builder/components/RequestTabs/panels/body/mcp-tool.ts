/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The text an `mcp` body's tool fields hold, and the tool it commits (#3762).
 *
 * The two fields are typed one at a time, but the engine refuses a stored tool
 * with a blank name or an `inputSchema` that is not an object, and refuses the
 * whole save for it. So the editor state is not committed key by key: it is
 * read here, and only a tool the engine would accept reaches the request. What
 * is left over (a schema typed before its tool is named, half-typed JSON) stays
 * in the fields with its reason.
 */

import type { McpTool } from "@/types";

export interface McpToolFields {
	name: string;
	/** The `inputSchema` as typed; blank means the tool states none. */
	schema: string;
}

export interface McpToolReading {
	/** What to store, or undefined when the fields hold nothing the engine would take. */
	tool: McpTool | undefined;
	nameError: string | null;
	schemaError: string | null;
}

export const SCHEMA_NOT_AN_OBJECT = "The input schema must be a JSON object.";
export const SCHEMA_WITHOUT_NAME = "Name the tool, or this schema is not saved.";

/** The fields a stored tool is edited as; the schema is indented for reading. */
export function fieldsOf(tool: McpTool | undefined): McpToolFields {
	if (!tool) return { name: "", schema: "" };
	return {
		name: tool.name,
		schema: tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : "",
	};
}

type SchemaReading = { ok: true; schema: Record<string, unknown> | undefined } | { ok: false };

function readSchema(text: string): SchemaReading {
	if (text.trim() === "") return { ok: true, schema: undefined };
	try {
		const parsed: unknown = JSON.parse(text);
		const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
		return isObject ? { ok: true, schema: parsed as Record<string, unknown> } : { ok: false };
	} catch {
		return { ok: false };
	}
}

/** The tool the fields commit and what is wrong with them, if anything. */
export function readFields(fields: McpToolFields): McpToolReading {
	const name = fields.name.trim();
	const schema = readSchema(fields.schema);
	if (!schema.ok) return { tool: undefined, nameError: null, schemaError: SCHEMA_NOT_AN_OBJECT };
	if (name === "") {
		const stranded = schema.schema !== undefined;
		return {
			tool: undefined,
			nameError: stranded ? SCHEMA_WITHOUT_NAME : null,
			schemaError: null,
		};
	}
	return {
		tool: { name, ...(schema.schema && { inputSchema: schema.schema }) },
		nameError: null,
		schemaError: null,
	};
}

/**
 * Whether the fields still describe @p tool. A request switch or an external
 * write changes the tool under the fields; typing does not, because the
 * fields are what produced it. Half-typed JSON describes whatever tool is
 * stored: the stored tool stays until the text is valid again, so an autosave
 * in between does not drop it.
 */
export function describes(fields: McpToolFields, tool: McpTool | undefined): boolean {
	const reading = readFields(fields);
	if (reading.schemaError) return true;
	return JSON.stringify(reading.tool ?? null) === JSON.stringify(tool ?? null);
}
