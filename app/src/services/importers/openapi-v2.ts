/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	DeclaredOperation,
	DeclaredResponseSchema,
	SpecOperation,
	FormFieldEntry,
	HttpMethod,
	KeyValueEntry,
	RequestAuth,
	RequestBody,
} from "@/types";
import type {
	CollectionDraft,
	ExampleDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	RequestDraft,
} from "./types";
import { asArray, asRecord, asStr, prop, type JsonRecord } from "@/lib/json-node";
import { sampleSchema } from "./schema-sampler";
import { normalizeVars } from "./var-normalize";
import { mapSwaggerOAuth2 } from "./oauth2-import";
import {
	createRefResolver,
	declaredParamRow,
	declaredResponsesOf,
	deref,
	exampleBodyText,
	resolvePathItem,
	responseExample,
	SkipTally,
	createOperationIdentifier,
} from "./openapi-shared";
import { countExamples, importedFilePart, unattachedFileParts } from "./shared";
import { buildResponseSchemaIndex, responseSchemasV2 } from "./response-schemas";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** A `consumes` entry stripped of its parameters, e.g. `"multipart/form-data; boundary=x"`. */
const mediaType = (c: unknown): string =>
	String(c ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
const isUrlEncodedType = (c: unknown): boolean =>
	mediaType(c) === "application/x-www-form-urlencoded";
const isMultipartType = (c: unknown): boolean => mediaType(c) === "multipart/form-data";

export function swaggerSchemeToAuth(scheme: unknown): Exclude<RequestAuth, { mode: "inherit" }> {
	const node = asRecord(scheme);
	if (!node || !node.type) return { mode: "none" };
	if (node.type === "basic") return { mode: "basic", username: "", password: "" };
	if (node.type === "apiKey") {
		return {
			mode: "apikey",
			key: asStr(node.name) ?? "",
			value: "",
			in: node.in === "query" ? "query" : "header",
		};
	}
	if (node.type === "oauth2") return mapSwaggerOAuth2(node);
	return { mode: "none" };
}

export class OpenApiV2Parser implements ImportParser {
	readonly formatName = "OpenAPI 2.0 (Swagger)";
	readonly formatKey = "openapi-v2";

	detect(parsed: unknown, _raw: string): boolean {
		return prop(parsed, "swagger") === "2.0";
	}

	parse(parsed: unknown, raw: string, _opts: ImportOptions): ImportResult {
		const spec = asRecord(parsed) ?? {};
		const resolveRef = createRefResolver(spec);

		const scheme = asStr(asArray(spec.schemes)[0]) ?? "https";
		const basePathValue = asStr(spec.basePath);
		const basePath = basePathValue && basePathValue !== "/" ? basePathValue : "";
		const host = asStr(spec.host);
		const baseUrl = host ? `${scheme}://${host}${basePath}` : "";

		const required = asRecord(asArray(spec.security)[0]);
		const reqName = required ? Object.keys(required)[0] : undefined;
		const defs = asRecord(spec.securityDefinitions) ?? {};
		const primaryScheme = (reqName && defs[reqName]) || Object.values(defs)[0];

		const tagCollections = new Map<string, CollectionDraft>();
		const rootRequests: RequestDraft[] = [];
		const tally = new SkipTally();
		// One identifier for the whole document: it is what keeps a repeated
		// `operationId` off the second request that would otherwise claim it
		// (issue #715), which needs the memory of every id already stamped.
		const identify = createOperationIdentifier(tally);
		let requestCount = 0;
		// The declared-operation index (issue #629) - see the v3 parser for why
		// it is built in this walk rather than by a second pass over `paths`.
		const declaredOperations: DeclaredOperation[] = [];
		// The response schema index (issue #628) - see the v3 parser. 2.0 states
		// its media types per operation (`produces`) rather than per response,
		// which `responseSchemasV2` is what accounts for.
		const schemaOperations: { identity: SpecOperation; responses: DeclaredResponseSchema[] }[] =
			[];

		for (const [path, rawPathItem] of Object.entries(asRecord(spec.paths) ?? {})) {
			const pathItem = resolvePathItem(rawPathItem, resolveRef);
			if (!pathItem) {
				tally.add("malformed_spec");
				continue;
			}
			const pathParams = tally.params(pathItem.parameters);
			for (const method of HTTP_METHODS) {
				const op = asRecord(pathItem[method]);
				if (!op) continue;
				requestCount += 1;
				const identity = identify(method, path, op.operationId);
				if (identity) {
					declaredOperations.push({
						...identity,
						responses: declaredResponsesOf(op.responses),
					});
					schemaOperations.push({
						identity,
						responses: responseSchemasV2(op, spec, resolveRef),
					});
				}
				const req = buildSwaggerOp(
					method,
					path,
					op,
					spec,
					resolveRef,
					pathParams,
					tally,
					identity
				);
				const tag = asStr(asArray(op.tags)[0]);
				if (tag) {
					if (!tagCollections.has(tag)) {
						const def = asArray(spec.tags).find((t) => prop(t, "name") === tag);
						tagCollections.set(tag, {
							name: tag,
							description: asStr(prop(def, "description")) ?? "",
							variables: {},
							auth: { mode: "none" },
							preRequestScript: "",
							postRequestScript: "",
							children: [],
							requests: [],
						});
					}
					tagCollections.get(tag)!.requests.push(req);
				} else {
					rootRequests.push(req);
				}
			}
		}

		const responseSchemas = buildResponseSchemaIndex(spec, schemaOperations);

		const root: CollectionDraft = {
			name: asStr(prop(spec.info, "title")) ?? "Imported API",
			description: asStr(prop(spec.info, "description")) ?? "",
			variables: baseUrl ? { baseUrl: { value: baseUrl, enabled: true } } : {},
			auth: swaggerSchemeToAuth(primaryScheme),
			preRequestScript: "",
			postRequestScript: "",
			children: [...tagCollections.values()],
			requests: rootRequests,
			// The document itself, so the import can store it and bind this
			// collection to it in the same atomic call (issue #637) - see the v3
			// parser for why it is `raw` rather than a re-serialization, and for
			// why the declared-operation index (issue #629) rides beside it.
			spec: {
				content: raw,
				...(declaredOperations.length > 0 ? { operations: declaredOperations } : {}),
				...(responseSchemas ? { responseSchemas } : {}),
			},
		};

		return {
			collections: [root],
			environments: [],
			globals: {}, // a spec has no environment or globals concept
			meta: {
				format: this.formatName,
				requestCount,
				folderCount: tagCollections.size,
				environmentCount: 0,
				globalCount: 0,
				exampleCount: countExamples([root]),
				skipped: tally.items(),
				nonExecutableAuth: 0,
				unattachedFileParts: unattachedFileParts([root]),
			},
		};
	}
}

function buildSwaggerOp(
	method: string,
	path: string,
	op: JsonRecord,
	spec: JsonRecord,
	resolveRef: (r: string) => unknown,
	pathParams: unknown[],
	tally: SkipTally,
	/** The identity `parse` claimed for this operation - see the v3 parser. */
	specOperation: SpecOperation | undefined
): RequestDraft {
	const params: KeyValueEntry[] = [];
	const headers: KeyValueEntry[] = [];
	let body: RequestBody = { mode: "none" };
	const formFields: FormFieldEntry[] = [];

	const consumes = (Array.isArray(op.consumes) ? op.consumes : asArray(spec.consumes)).map(
		(c) => asStr(c) ?? ""
	);
	const isJsonConsume =
		consumes.length === 0 ||
		consumes.some(
			(c) =>
				c === "application/json" || c.startsWith("application/json;") || c.endsWith("+json")
		);
	// Swagger 2.0 ties `formData` encoding to `consumes` - urlencoded and multipart are
	// distinct wire encodings, and Vayu models them as distinct body modes. Multipart wins
	// when both are listed (only it can carry a `type: file` field), and a `consumes` that
	// names neither keeps the historical multipart default.
	const formMode: "form-data" | "x-www-form-urlencoded" =
		consumes.some(isUrlEncodedType) && !consumes.some(isMultipartType)
			? "x-www-form-urlencoded"
			: "form-data";

	// Resolve $ref params and dedupe by name+in (operation overrides path-item).
	const byKey = new Map<string, JsonRecord>();
	for (const param of [...pathParams, ...tally.params(op.parameters)]) {
		const ref = asStr(prop(param, "$ref"));
		const resolved = asRecord(ref ? resolveRef(ref) : param);
		if (!resolved || !resolved.in || !resolved.name) continue;
		byKey.set(`${String(resolved.in)}:${String(resolved.name)}`, resolved);
	}

	for (const param of byKey.values()) {
		const name = String(param.name);
		const description = asStr(param.description);
		switch (asStr(param.in)) {
			case "query":
				// Swagger 2.0 states a non-body parameter's value inline as `default`;
				// it has no `example` keyword (that arrived with v3's Example Object).
				params.push(declaredParamRow(name, param.default, param.required, description));
				break;
			case "header": {
				const lower = name.toLowerCase();
				// Same value/enabled rule as a query row (#658). No description: the
				// Headers table has no column for one, so carrying it would be a field
				// nothing reads.
				if (lower !== "authorization" && lower !== "content-type")
					headers.push(declaredParamRow(name, param.default, param.required));
				break;
			}
			case "body": {
				const sample = param.schema ? sampleSchema(param.schema, resolveRef) : {};
				body = isJsonConsume
					? { mode: "json", content: JSON.stringify(sample, null, 2) }
					: { mode: "text", content: JSON.stringify(sample, null, 2) };
				break;
			}
			case "formData": {
				const entry = { key: name, value: "", enabled: true };
				// A spec names the upload, never the file - the part imports with no
				// path and the user attaches one. Left as a text row (what this did
				// until #425) it looked like a healthy field and sent nothing.
				formFields.push(param.type === "file" ? importedFilePart(entry, "") : entry);
				break;
			}
		}
	}
	if (formFields.length > 0) {
		// A file part has no urlencoded wire form, so a spec that declares one under
		// a urlencoded-only `consumes` contradicts itself; multipart is the half of
		// that contradiction which can carry the field.
		const mode = formFields.some((f) => f.type === "file") ? "form-data" : formMode;
		body = { mode, fields: formFields };
	}

	const examples = buildSwaggerExamples(op, spec, resolveRef, tally);
	return {
		name: asStr(op.summary) ?? asStr(op.operationId) ?? `${method.toUpperCase()} ${path}`,
		description: asStr(op.description) ?? "",
		method: method.toUpperCase() as HttpMethod,
		url: `{{baseUrl}}${normalizeVars(path, { pathTemplates: true })}`,
		params,
		headers,
		body,
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		...(examples.length > 0 ? { examples } : {}),
		...(specOperation ? { specOperation } : {}),
	};
}

/**
 * A Swagger 2.0 operation's `responses` → saved example responses (issue #481).
 *
 * The 2.0 shape puts the payload on the response itself rather than under a
 * media-type map: `examples` is keyed by MIME type and holds the value
 * directly, and `schema` describes it. Precedence is the documented example
 * first, then a sample generated from the schema - the same order the v3 parser
 * uses, and the same order this file already uses for a request body.
 *
 * The media type comes from the operation's `produces` (falling back to the
 * spec-level one), because a 2.0 response does not name its own.
 */
function buildSwaggerExamples(
	op: JsonRecord,
	spec: JsonRecord,
	resolveRef: (r: string) => unknown,
	tally: SkipTally
): ExampleDraft[] {
	const map = asRecord(op.responses);
	if (!map) return [];
	const produces = (Array.isArray(op.produces) ? op.produces : asArray(spec.produces)).map(
		(p) => asStr(p) ?? ""
	);
	const jsonProduced =
		produces.find(
			(p) => mediaType(p) === "application/json" || mediaType(p).endsWith("+json")
		) ?? (produces.length === 0 ? "application/json" : undefined);

	const out: ExampleDraft[] = [];
	for (const [code, rawResponse] of Object.entries(map)) {
		const draft = responseExample(code, deref(rawResponse, resolveRef), tally, (response) => {
			// `examples` is keyed by MIME type and carries the value itself - no
			// Example Object wrapper, unlike v3.
			const declared = asRecord(response.examples);
			const contentType = jsonProduced ?? produces[0] ?? "application/json";
			const documented = declared
				? (declared[contentType] ?? declared["application/json"])
				: undefined;
			if (documented !== undefined) {
				return { body: exampleBodyText(documented), contentType };
			}
			if (!response.schema) return undefined;
			return {
				body: exampleBodyText(sampleSchema(response.schema, resolveRef)),
				contentType,
			};
		});
		if (draft) out.push(draft);
	}
	return out;
}
