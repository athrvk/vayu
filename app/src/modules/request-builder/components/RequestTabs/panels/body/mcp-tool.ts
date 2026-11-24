/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The text an `mcp` body's tool fields hold, and the tool it commits (#3762). Fields are typed one
 * at a time, but the engine refuses a stored tool with a blank name or a non-object `inputSchema`,
 * failing the whole save. The `outputSchema` (#3806) gets the same rule though the engine never
 * reads it: the builder does, and a non-object would be a default nothing could fill. So the state
 * is read here and only a tool the engine would accept is committed; leftovers (a schema typed
 * before the name, half-typed JSON) stay in the fields with their reason.
 */

import type { McpTool } from "@/types";

export interface McpToolFields {
	name: string;
	/** The `inputSchema` as typed; blank means the tool states none. */
	schema: string;
	/** The `outputSchema` as typed; blank means the tool states none. */
	outputSchema: string;
}

export interface McpToolReading {
	/** What to store, or undefined when the fields hold nothing the engine would take. */
	tool: McpTool | undefined;
	nameError: string | null;
	schemaError: string | null;
	outputSchemaError: string | null;
}

export const SCHEMA_NOT_AN_OBJECT = "The input schema must be a JSON object.";
export const OUTPUT_SCHEMA_NOT_AN_OBJECT = "The output schema must be a JSON object.";
export const SCHEMA_WITHOUT_NAME = "Name the tool, or this schema is not saved.";

function indented(schema: Record<string, unknown> | undefined): string {
	return schema ? JSON.stringify(schema, null, 2) : "";
}

/** The fields a stored tool is edited as; the schemas are indented for reading. */
export function fieldsOf(tool: McpTool | undefined): McpToolFields {
	return {
		name: tool?.name ?? "",
		schema: indented(tool?.inputSchema),
		outputSchema: indented(tool?.outputSchema),
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
	const input = readSchema(fields.schema);
	const output = readSchema(fields.outputSchema);
	if (!input.ok || !output.ok) {
		return {
			tool: undefined,
			nameError: null,
			schemaError: input.ok ? null : SCHEMA_NOT_AN_OBJECT,
			outputSchemaError: output.ok ? null : OUTPUT_SCHEMA_NOT_AN_OBJECT,
		};
	}
	if (name === "") {
		const stranded = input.schema !== undefined || output.schema !== undefined;
		return {
			tool: undefined,
			nameError: stranded ? SCHEMA_WITHOUT_NAME : null,
			schemaError: null,
			outputSchemaError: null,
		};
	}
	return {
		tool: {
			name,
			...(input.schema && { inputSchema: input.schema }),
			...(output.schema && { outputSchema: output.schema }),
		},
		nameError: null,
		schemaError: null,
		outputSchemaError: null,
	};
}

/**
 * Whether the fields still describe @p tool. A request switch or external write changes the tool
 * under them; typing does not, since the fields produced it. Half-typed JSON describes the stored
 * tool, which stays until the text is valid, so an autosave in between does not drop it.
 */
export function describes(fields: McpToolFields, tool: McpTool | undefined): boolean {
	const reading = readFields(fields);
	if (reading.schemaError || reading.outputSchemaError) return true;
	return sameJson(reading.tool ?? null, tool ?? null);
}

/**
 * JSON values compare regardless of member order (a schema read back from the engine need not keep
 * its typed order, and a reorder is no edit); an `undefined` member is absent, as in
 * `JSON.stringify`.
 */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, i) => sameJson(item, b[i]))
		);
	}
	const left = definedMembers(a);
	const right = new Map(definedMembers(b));
	return (
		left.length === right.size &&
		left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)))
	);
}

function definedMembers(value: object): Array<[string, unknown]> {
	return Object.entries(value).filter(([, member]) => member !== undefined);
}
