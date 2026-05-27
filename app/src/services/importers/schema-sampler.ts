/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

type Schema = Record<string, any>;
export type RefResolver = (ref: string) => unknown;

const MAX_DEPTH = 6;

/**
 * Generate a sample value for an OpenAPI/Swagger schema.
 * Bounded: depth-capped, $ref-cycle-guarded, first-branch for allOf/oneOf/anyOf.
 */
export function sampleSchema(schema: unknown, resolveRef: RefResolver): unknown {
	return walk(schema, resolveRef, 0, new Set<string>());
}

function walk(
	node: unknown,
	resolveRef: RefResolver,
	depth: number,
	seenRefs: Set<string>
): unknown {
	if (depth > MAX_DEPTH || node == null || typeof node !== "object") return {};
	const schema = node as Schema;

	if ("$ref" in schema && typeof schema.$ref === "string") {
		if (seenRefs.has(schema.$ref)) return {}; // cycle guard
		let resolved: unknown;
		try {
			resolved = resolveRef(schema.$ref);
		} catch {
			return {};
		}
		if (resolved == null) return {};
		return walk(resolved, resolveRef, depth + 1, new Set([...seenRefs, schema.$ref]));
	}

	if ("example" in schema) return schema.example;

	const branch = schema.allOf ?? schema.oneOf ?? schema.anyOf;
	if (Array.isArray(branch) && branch.length > 0) {
		return walk(branch[0], resolveRef, depth + 1, seenRefs);
	}

	switch (schema.type) {
		case "string":
			return Array.isArray(schema.enum) && schema.enum.length ? schema.enum[0] : "";
		case "integer":
		case "number":
			return 0;
		case "boolean":
			return false;
		case "array":
			return schema.items ? [walk(schema.items, resolveRef, depth + 1, seenRefs)] : [];
		case "object":
		default: {
			// no/unknown type: fall back to walking properties
			const props = schema.properties;
			if (props && typeof props === "object") {
				const out: Record<string, unknown> = {};
				for (const key of Object.keys(props)) {
					out[key] = walk(props[key], resolveRef, depth + 1, seenRefs);
				}
				return out;
			}
			return {};
		}
	}
}
