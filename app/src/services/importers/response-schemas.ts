/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Extracting the response schemas a document declares, so the engine can check
 * responses against them (issue #628).
 *
 * The engine validates; it does not read OpenAPI. That division (#625, decision
 * 3) puts two jobs here:
 *
 * 1. **Find** each operation's declared response schemas, by status and media
 *    type, in either dialect - v3's `responses[status].content[type].schema` and
 *    v2's `responses[status].schema` with `produces`.
 * 2. **Translate** them into the dialect a JSON Schema validator reads. This is
 *    the half that is easy to skip and expensive to skip: OpenAPI 3.0's schema
 *    language is *not* JSON Schema. `nullable: true` means "or null" and no
 *    validator has heard of it, so a null a document explicitly permits would be
 *    reported as a type failure - a **wrong** verdict, which is worse than no
 *    verdict. `exclusiveMinimum: true` is draft-04's spelling and means
 *    something else entirely in draft-07. `discriminator` and `xml` are
 *    OpenAPI's own vocabulary and mean nothing to a validator.
 *
 * What is deliberately *not* done here is dereferencing. Schemas are kept as
 * written and the document's `components` / `definitions` / `x-vayu-bundled`
 * subtrees are stored once beside them as `refRoots`; the engine merges the two
 * to form a validation root. Inlining instead would duplicate a shared `Error`
 * schema into every operation naming it, and a recursive schema - a tree node
 * whose child is itself - has no finite expansion at all.
 *
 * 3.1 schemas are already JSON Schema (2020-12) and pass through untouched.
 * Their 2020-12-only keywords are not translated: the engine discloses each one
 * it could not evaluate, by name and count, which is honest in a way a silent
 * partial translation would not be.
 */

import type { DeclaredResponseSchema, ResponseSchemaIndex, SpecOperation } from "@/types";

import { asArray, asRecord, asStr } from "@/lib/json-node";

/** Where #649's bundler inlines the external files a document referenced. */
const BUNDLED_KEY = "x-vayu-bundled";

/**
 * Keys OpenAPI adds to its schema language that a JSON Schema validator has
 * never heard of. Dropped rather than passed through: each one is either
 * documentation (`example`, `externalDocs`, `xml`) or a serialization concern
 * (`discriminator`), and none of them constrains a body.
 *
 * `nullable` is deliberately absent - it *does* constrain a body, so it is
 * translated below rather than dropped.
 */
const OPENAPI_ONLY_KEYS = new Set(["discriminator", "xml", "externalDocs", "example"]);

/** Where a keyword holds one subschema. */
const SUBSCHEMA_KEYS = [
	"not",
	"if",
	"then",
	"else",
	"contains",
	"additionalProperties",
	"propertyNames",
	"additionalItems",
	"unevaluatedItems",
	"unevaluatedProperties",
];

/** Where a keyword holds a map of subschemas keyed by *data* names. */
const SUBSCHEMA_MAP_KEYS = [
	"properties",
	"patternProperties",
	"definitions",
	"$defs",
	"dependentSchemas",
];

/** Where a keyword holds a list of subschemas. */
const SUBSCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/**
 * Translate one schema - and everything below it - out of OpenAPI's dialect and
 * into JSON Schema.
 *
 * Recursion is over the *document's* structure, which is finite: a `$ref` is
 * copied as-is rather than followed, so a recursive schema terminates here for
 * the same reason it terminates in storage.
 */
export function toJsonSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(toJsonSchema);
	// `true` / `false` are legal schemas, and any non-object leaf (a `type`
	// string, a `maxLength` number) is carried through untouched.
	const node = asRecord(schema);
	if (!node) return schema;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (OPENAPI_ONLY_KEYS.has(key)) continue;

		if (key === "nullable") {
			// Handled below, once, against whatever `type` ends up being - doing
			// it here would depend on key order.
			continue;
		}
		if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
			// draft-04 (and so OpenAPI 3.0) spells these as booleans modifying
			// `minimum`/`maximum`; draft-07 spells them as the bound itself. A
			// boolean left as-is is not a stricter check, it is a different one.
			if (typeof value === "boolean") {
				const bound = key === "exclusiveMinimum" ? node.minimum : node.maximum;
				if (value && typeof bound === "number") out[key] = bound;
				continue;
			}
			out[key] = value;
			continue;
		}
		if (SUBSCHEMA_KEYS.includes(key)) {
			out[key] = toJsonSchema(value);
			continue;
		}
		if (SUBSCHEMA_MAP_KEYS.includes(key)) {
			const map = asRecord(value);
			if (!map) {
				out[key] = value;
				continue;
			}
			const translated: Record<string, unknown> = {};
			for (const [name, child] of Object.entries(map)) translated[name] = toJsonSchema(child);
			out[key] = translated;
			continue;
		}
		if (SUBSCHEMA_LIST_KEYS.includes(key)) {
			out[key] = Array.isArray(value) ? value.map(toJsonSchema) : toJsonSchema(value);
			continue;
		}
		if (key === "items") {
			out[key] = Array.isArray(value) ? value.map(toJsonSchema) : toJsonSchema(value);
			continue;
		}
		out[key] = value;
	}

	// `exclusiveMinimum: true` without its bound leaves `minimum` doing the
	// non-exclusive job the document did not ask for - but dropping `minimum`
	// too would lose a constraint the document *did* state. Keeping it is the
	// conservative half of the two.
	if (node.nullable === true) {
		const type = out.type;
		if (typeof type === "string") {
			out.type = [type, "null"];
		} else if (Array.isArray(type)) {
			out.type = type.includes("null") ? type : [...type, "null"];
		}
		// With no `type` at all, `nullable` constrains nothing: every JSON value
		// was already allowed, null included.
	}
	return out;
}

/**
 * The subtrees an in-document `$ref` may resolve into, translated once per
 * document so a `$ref`-ed schema is in the same dialect as an inline one.
 *
 * `undefined` when the document has none, which stores no `refRoots` at all
 * rather than an empty object.
 */
export function refRootsOf(spec: Record<string, unknown>): Record<string, unknown> | undefined {
	const roots: Record<string, unknown> = {};

	// `components.schemas` and `definitions` hold schemas keyed by name, so each
	// *value* is translated - `toJsonSchema` on the container itself would walk
	// no further than the container, which is how a `$ref`-ed 3.0 schema kept
	// its `nullable` and produced a wrong verdict for every null the document
	// permits.
	//
	// The rest of `components` - responses, parameters, examples, headers - is
	// deliberately dropped rather than carried: a schema `$ref` resolves to a
	// schema, so nothing here can point at them, and they are pure weight
	// against the byte cap the index shares with the document.
	const schemas = asRecord(asRecord(spec.components)?.schemas);
	if (schemas) roots.components = { schemas: mapSchemas(schemas) };

	const definitions = asRecord(spec.definitions);
	if (definitions) roots.definitions = mapSchemas(definitions);

	// A bundled file (#649) is a whole document inlined under its slug, and a
	// ref into it keeps that document's own shape - so each is reduced by this
	// same rule. One that carries neither container *is* a schema document (a
	// bare `pet.yaml`), and is translated as one.
	const bundled = asRecord(spec[BUNDLED_KEY]);
	if (bundled) {
		const inlined: Record<string, unknown> = {};
		for (const [slug, document] of Object.entries(bundled)) {
			const node = asRecord(document);
			if (!node) continue;
			inlined[slug] = refRootsOf(node) ?? toJsonSchema(node);
		}
		if (Object.keys(inlined).length > 0) roots[BUNDLED_KEY] = inlined;
	}

	return Object.keys(roots).length > 0 ? roots : undefined;
}

/** Each value of a name-keyed schema map, translated. */
function mapSchemas(map: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(map)) out[name] = toJsonSchema(schema);
	return out;
}

/**
 * An OpenAPI 3.x operation's declared response schemas.
 *
 * Every media type is kept, not just the JSON one: what can be validated is
 * decided at response time by what the server actually sent, and a document
 * declaring both `application/json` and `application/xml` describes two real
 * responses. A media type whose response declares no schema is skipped - there
 * is nothing to check against, and an empty schema would claim everything is
 * valid.
 */
export function responseSchemasV3(operation: Record<string, unknown>): DeclaredResponseSchema[] {
	const responses = asRecord(operation.responses);
	if (!responses) return [];

	const declared: DeclaredResponseSchema[] = [];
	for (const [status, response] of Object.entries(responses)) {
		const node = asRecord(response);
		if (!node || !status) continue;
		const content = asRecord(node.content);
		if (!content) continue;
		for (const [mediaType, media] of Object.entries(content)) {
			const schema = asRecord(media)?.schema;
			if (schema === undefined) continue;
			declared.push({
				status,
				contentType: mediaType.toLowerCase(),
				schema: toJsonSchema(schema),
			});
		}
	}
	return declared;
}

/**
 * A Swagger 2.0 operation's declared response schemas.
 *
 * 2.0 states the media types once for the whole operation (`produces`, falling
 * back to the document's), and the schema once per response - so one response
 * declares the same schema for each type it produces. The JSON one leads for
 * the same reason it leads when importing examples.
 */
export function responseSchemasV2(
	operation: Record<string, unknown>,
	spec: Record<string, unknown>
): DeclaredResponseSchema[] {
	const responses = asRecord(operation.responses);
	if (!responses) return [];

	const produced = (
		Array.isArray(operation.produces) ? operation.produces : asArray(spec.produces)
	)
		.map((type: unknown) => asStr(type)?.toLowerCase())
		.filter((type): type is string => !!type);
	const mediaTypes = produced.length > 0 ? produced : ["application/json"];

	const declared: DeclaredResponseSchema[] = [];
	for (const [status, response] of Object.entries(responses)) {
		const node = asRecord(response);
		if (!node || !status || node.schema === undefined) continue;
		const schema = toJsonSchema(node.schema);
		for (const contentType of mediaTypes) {
			declared.push({ status, contentType, schema });
		}
	}
	return declared;
}

/**
 * Assemble the index the engine stores, or `undefined` when the document
 * declares no response schema at all.
 *
 * `undefined` rather than an empty index on purpose: the engine spells "no
 * index" and "declares nothing" the same way in storage, and the honest one of
 * the two for a document nothing was extracted from is "no index" - a response
 * of it reports `checked: false`, never a body that passed.
 */
export function buildResponseSchemaIndex(
	spec: Record<string, unknown>,
	operations: { identity: SpecOperation; responses: DeclaredResponseSchema[] }[]
): ResponseSchemaIndex | undefined {
	const rows = operations
		.filter((operation) => operation.responses.length > 0)
		.map((operation) => ({ ...operation.identity, responses: operation.responses }));
	if (rows.length === 0) return undefined;

	const refRoots = refRootsOf(spec);
	return { ...(refRoots ? { refRoots } : {}), operations: rows };
}
