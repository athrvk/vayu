/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning what Vayu stores - example bodies, request bodies - into what an
 * OpenAPI document writes (issue #630).
 *
 * Both export directions need the same two answers, which is why they live here
 * rather than in either one: what value goes under `example`, and whether a
 * `schema` may appear beside it at all.
 *
 * **Vayu does not invent schemas it never saw.** A skeleton export describes a
 * body only where there is an example body to read a shape off, and what it
 * writes is the shape of that one example - types, one level of nesting at a
 * time - never a guess at what the endpoint accepts in general. The derived
 * subtree says so in its own `description`, so a reader of the exported document
 * can tell a described contract from a shape Vayu read off a sample.
 */

import type { JsonRecord } from "@/lib/json-node";

/**
 * The sentence a derived schema carries. Load-bearing: it is the difference
 * between "the API declares this" and "Vayu saw one body that looked like this",
 * and the exported document is read by people who were not here when it was
 * made.
 */
export const DERIVED_SCHEMA_NOTE = "Shape derived from an example body, not a declared schema.";

/**
 * An example body as the value an `example` field holds.
 *
 * JSON when it parses as JSON, the text itself when it does not. A body Vayu
 * stored is whatever the server sent or the spec declared, so a non-JSON body -
 * XML, a plain-text error - is written as the string it is rather than dropped:
 * `example` is typed as "any value", and a string is a value.
 */
export function exampleValue(body: string): unknown {
	const text = body.trim();
	if (!text) return "";
	try {
		return JSON.parse(text);
	} catch {
		return body;
	}
}

/**
 * The shape of one example value, or `undefined` when there is nothing to read a
 * shape off.
 *
 * Deliberately shallow in what it claims: types, `properties` for an object and
 * `items` for an array's first element, and nothing else - no `required`, no
 * formats, no enums. Those are assertions about the endpoint, and one sample
 * cannot support them.
 */
export function schemaFromExample(value: unknown, note = DERIVED_SCHEMA_NOTE): JsonRecord {
	return { ...shapeOf(value), ...(note ? { description: note } : {}) };
}

function shapeOf(value: unknown): JsonRecord {
	if (value === null) return { type: "null" };
	if (Array.isArray(value)) {
		// An empty array says its type and nothing about its members - `items` from
		// no member would be an invention.
		return value.length > 0 ? { type: "array", items: shapeOf(value[0]) } : { type: "array" };
	}
	switch (typeof value) {
		case "string":
			return { type: "string" };
		case "boolean":
			return { type: "boolean" };
		case "number":
			return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
		case "object": {
			const properties: JsonRecord = {};
			for (const [key, member] of Object.entries(value as JsonRecord)) {
				properties[key] = shapeOf(member);
			}
			return { type: "object", properties };
		}
		default:
			// `undefined`, a function, a symbol: not values JSON produces, so this
			// is unreachable from a parsed body and stays a type-level default.
			return {};
	}
}
