/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { asRecord, prop } from "@/lib/json-node";

type Schema = Record<string, unknown>;
export type RefResolver = (ref: string) => unknown;

const MAX_DEPTH = 6;

/**
 * Generate a sample value for an OpenAPI/Swagger schema.
 * Bounded: depth-capped, $ref-cycle-guarded, first-branch for allOf/oneOf/anyOf.
 */
export function sampleSchema(schema: unknown, resolveRef: RefResolver): unknown {
	return walk(schema, resolveRef, 0, new Set<string>());
}

/** One field of a form body: its name, and whether it uploads a file rather than text. */
export interface SchemaFormField {
	name: string;
	/** `format: "binary"`, or an array of it - the only way OpenAPI 3 spells "a file". */
	file: boolean;
}

/**
 * Fields for a form body, read off the sampled stub rather than `schema.properties`.
 * Going through `sampleSchema` is the point: a form schema written as `{$ref: ...}` or
 * `allOf` (what generators emit) has no literal `properties`, and reading that key
 * directly produced an empty field list. Form bodies now resolve exactly as far as JSON
 * bodies do - first branch only for `allOf`/`oneOf`/`anyOf`, since that is what the
 * sampler does for both. A schema that samples to a non-object (a scalar, an array, or an
 * `example` that is not an object) has no fields to give.
 *
 * `file` is resolved separately, against the property schemas: the sampler flattens a
 * `format: binary` string to `""`, which is indistinguishable from a text field - the
 * reason issue #425's uploads imported as empty text rows. The property lookup follows
 * the same first-branch rule, so it agrees with the names; a schema whose fields came
 * from an `example` has no property schemas to consult and every field reads as text.
 */
export function schemaFormFields(schema: unknown, resolveRef: RefResolver): SchemaFormField[] {
	if (schema == null) return [];
	const sample = sampleSchema(schema, resolveRef);
	if (!sample || typeof sample !== "object" || Array.isArray(sample)) return [];
	const props = asRecord(prop(resolveToSchema(schema, resolveRef, 0, new Set()), "properties"));
	return Object.keys(sample).map((name) => ({
		name,
		file: isBinary(props?.[name], resolveRef, 0, new Set()),
	}));
}

/**
 * The schema a node ultimately denotes: `$ref` and the first `allOf`/`oneOf`/`anyOf`
 * branch followed, under the sampler's own depth cap and cycle guard. Split out of
 * `walk` because `walk` returns a *value* and the caller needs the declaration.
 */
function resolveToSchema(
	node: unknown,
	resolveRef: RefResolver,
	depth: number,
	seenRefs: Set<string>
): Schema | undefined {
	if (depth > MAX_DEPTH || node == null || typeof node !== "object") return undefined;
	const schema = node as Schema;
	if ("$ref" in schema && typeof schema.$ref === "string") {
		if (seenRefs.has(schema.$ref)) return undefined;
		let resolved: unknown;
		try {
			resolved = resolveRef(schema.$ref);
		} catch {
			return undefined;
		}
		return resolveToSchema(
			resolved,
			resolveRef,
			depth + 1,
			new Set([...seenRefs, schema.$ref])
		);
	}
	const branch = schema.allOf ?? schema.oneOf ?? schema.anyOf;
	if (Array.isArray(branch) && branch.length > 0) {
		return resolveToSchema(branch[0], resolveRef, depth + 1, seenRefs);
	}
	return schema;
}

/**
 * Whether a property schema declares a file upload. `type: array` of binary items is
 * the multi-file field, and Vayu's one-file-per-row model imports it as a single file
 * row - one file the user can attach beats a text row that sends nothing.
 */
function isBinary(
	node: unknown,
	resolveRef: RefResolver,
	depth: number,
	seenRefs: Set<string>
): boolean {
	const schema = resolveToSchema(node, resolveRef, depth, seenRefs);
	if (!schema) return false;
	if (schema.format === "binary") return true;
	return schema.type === "array" && isBinary(schema.items, resolveRef, depth + 1, seenRefs);
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

	// `const` outranks `example`: JSON Schema (adopted wholesale by OpenAPI 3.1) says the
	// value MUST be exactly this, where `example` is only an annotation.
	if ("const" in schema) return schema.const;
	if ("example" in schema) return schema.example;
	// 3.1 replaced the singular `example` with an `examples` array.
	if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];

	const branch = schema.allOf ?? schema.oneOf ?? schema.anyOf;
	if (Array.isArray(branch) && branch.length > 0) {
		return walk(branch[0], resolveRef, depth + 1, seenRefs);
	}

	// 3.1 writes a nullable field as a type array (`["string", "null"]`) where 3.0 wrote
	// `nullable: true`. Sample the first non-null member: a typed stub is what the user
	// edits, and only an all-`"null"` type has nothing else to offer.
	const type = Array.isArray(schema.type)
		? (schema.type.find((t: unknown) => t !== "null") ?? "null")
		: schema.type;

	switch (type) {
		case "string":
			return Array.isArray(schema.enum) && schema.enum.length ? schema.enum[0] : "";
		case "integer":
		case "number":
			return 0;
		case "boolean":
			return false;
		case "null":
			return null;
		case "array":
			return schema.items ? [walk(schema.items, resolveRef, depth + 1, seenRefs)] : [];
		case "object":
		default: {
			// no/unknown type: fall back to walking properties
			const props = asRecord(schema.properties);
			if (props) {
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
