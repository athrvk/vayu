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
import { sampleSchema, schemaFormFields } from "./schema-sampler";
import { normalizeVars } from "./var-normalize";
import { mapOpenApiV3OAuth2 } from "./oauth2-import";
import {
	createRefResolver,
	declaredParamRow,
	declaredResponsesOf,
	deref,
	exampleBodyText,
	findJsonMediaType,
	firstNamedExample,
	resolvePathItem,
	responseExample,
	SkipTally,
	specOperationOf,
} from "./openapi-shared";
import { countExamples, importedFilePart, unattachedFileParts } from "./shared";
import { buildResponseSchemaIndex, responseSchemasV3 } from "./response-schemas";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/**
 * Path Item Object methods Vayu has no `HttpMethod` for. `trace` is the whole list:
 * OpenAPI 3's path item defines exactly the eight methods, and adding `"TRACE"` to
 * `HttpMethod` is an execution-model change, not an import fix.
 */
const UNSUPPORTED_METHODS = ["trace"] as const;

/** Map an OpenAPI 3 securityScheme to a concrete collection-level auth (empty secrets). */
export function schemeToAuth(scheme: unknown): Exclude<RequestAuth, { mode: "inherit" }> {
	const node = asRecord(scheme);
	if (!node || !node.type) return { mode: "none" };
	if (node.type === "http" && node.scheme === "bearer") return { mode: "bearer", token: "" };
	if (node.type === "http" && node.scheme === "basic")
		return { mode: "basic", username: "", password: "" };
	if (node.type === "apiKey") {
		return {
			mode: "apikey",
			key: asStr(node.name) ?? "",
			value: "",
			in: node.in === "query" ? "query" : "header",
		};
	}
	if (node.type === "oauth2") return mapOpenApiV3OAuth2(node);
	return { mode: "none" };
}

export class OpenApiV3Parser implements ImportParser {
	readonly formatName = "OpenAPI 3.0";
	readonly formatKey = "openapi-v3";

	detect(parsed: unknown, _raw: string): boolean {
		const v = asStr(prop(parsed, "openapi"));
		return !!v && v.startsWith("3.");
	}

	parse(parsed: unknown, raw: string, _opts: ImportOptions): ImportResult {
		const spec = asRecord(parsed) ?? {};
		const resolveRef = createRefResolver(spec);

		const baseUrl = asStr(prop(asArray(spec.servers)[0], "url")) ?? "";
		const primaryScheme = pickPrimaryScheme(spec);

		const tagCollections = new Map<string, CollectionDraft>();
		const rootRequests: RequestDraft[] = [];
		const tally = new SkipTally();
		let requestCount = 0;
		// The declared-operation index stored beside the document (issue #629).
		// Built in this same walk rather than by a second pass over `paths`: a
		// reader that disagreed with this one about what the document declares
		// would make coverage disagree with the requests it counts.
		const declaredOperations: DeclaredOperation[] = [];
		// The response schemas stored beside the document (issue #628), gathered
		// in the same walk and for the same reason: a second pass could disagree
		// with this one about which operation declares what.
		const schemaOperations: { identity: SpecOperation; responses: DeclaredResponseSchema[] }[] =
			[];

		for (const [path, rawPathItem] of Object.entries(asRecord(spec.paths) ?? {})) {
			const pathItem = resolvePathItem(rawPathItem, resolveRef);
			if (!pathItem) {
				tally.add("malformed_spec");
				continue;
			}
			const pathParams = tally.params(pathItem.parameters);
			for (const unsupported of UNSUPPORTED_METHODS) {
				if (pathItem[unsupported] && typeof pathItem[unsupported] === "object")
					tally.add("unsupported_method");
			}
			for (const method of HTTP_METHODS) {
				const op = asRecord(pathItem[method]);
				if (!op) continue;
				requestCount += 1;
				const identity = specOperationOf(method, path, op.operationId);
				if (identity) {
					declaredOperations.push({
						...identity,
						responses: declaredResponsesOf(op.responses),
					});
					schemaOperations.push({ identity, responses: responseSchemasV3(op) });
				}
				const req = buildOperation(method, path, op, resolveRef, pathParams, tally);
				const tag = asStr(asArray(op.tags)[0]);
				if (tag) {
					if (!tagCollections.has(tag))
						tagCollections.set(tag, makeTagCollection(spec, tag));
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
			auth: schemeToAuth(primaryScheme),
			preRequestScript: "",
			postRequestScript: "",
			children: [...tagCollections.values()],
			requests: rootRequests,
			// The document itself, so the import can store it and bind this
			// collection to it in the same atomic call (issue #637). `raw` and not
			// a re-serialization: the engine hashes the bytes it stores, and a
			// sync compares against that hash.
			// `operations` beside it, so a run of this collection can report what
			// of the contract it covered without the engine parsing the document
			// (issue #629). Absent when the document declared none, which stores
			// as "no index" rather than as an empty contract.
			// `responseSchemas` likewise (issue #628), so a response can be checked
			// against what the document declared for it. Absent when nothing
			// declared a schema, which stores as "no index" rather than as a
			// contract that permits everything.
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

function pickPrimaryScheme(spec: JsonRecord): unknown {
	const required = asRecord(asArray(spec.security)[0]);
	const reqName = required ? Object.keys(required)[0] : undefined;
	const schemes = asRecord(prop(spec.components, "securitySchemes")) ?? {};
	if (reqName && schemes[reqName]) return schemes[reqName];
	return Object.values(schemes)[0];
}

function makeTagCollection(spec: JsonRecord, tag: string): CollectionDraft {
	const def = asArray(spec.tags).find((t) => prop(t, "name") === tag);
	return {
		name: tag,
		description: asStr(prop(def, "description")) ?? "",
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		children: [],
		requests: [],
	};
}

function buildOperation(
	method: string,
	path: string,
	op: JsonRecord,
	resolveRef: (r: string) => unknown,
	pathParams: unknown[],
	tally: SkipTally
): RequestDraft {
	const params: KeyValueEntry[] = [];
	const headers: KeyValueEntry[] = [];
	const byKey = new Map<string, JsonRecord>();
	for (const param of [...pathParams, ...tally.params(op.parameters)]) {
		const ref = asStr(prop(param, "$ref"));
		const resolved = asRecord(ref ? resolveRef(ref) : param);
		if (!resolved || !resolved.in || !resolved.name) continue;
		byKey.set(`${String(resolved.in)}:${String(resolved.name)}`, resolved); // later (operation) wins
	}
	for (const resolved of byKey.values()) {
		const name = String(resolved.name);
		const description = asStr(resolved.description);
		if (resolved.in === "query") {
			params.push(
				declaredParamRow(
					name,
					declaredParamValue(resolved, resolveRef),
					resolved.required,
					description
				)
			);
		} else if (resolved.in === "header") {
			const lower = name.toLowerCase();
			if (lower === "authorization" || lower === "content-type") continue;
			// Same value/enabled rule as a query row (#658). No description: the
			// Headers table has no column for one, so carrying it would be a field
			// nothing reads.
			headers.push(
				declaredParamRow(name, declaredParamValue(resolved, resolveRef), resolved.required)
			);
		}
	}
	const examples = buildExamples(op.responses, resolveRef, tally);
	const specOperation = specOperationOf(method, path, op.operationId);
	return {
		name: asStr(op.summary) ?? asStr(op.operationId) ?? `${method.toUpperCase()} ${path}`,
		description: asStr(op.description) ?? "",
		method: method.toUpperCase() as HttpMethod,
		url: `{{baseUrl}}${normalizeVars(path, { pathTemplates: true })}`,
		params,
		headers,
		body: buildBody(op.requestBody, resolveRef),
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		...(examples.length > 0 ? { examples } : {}),
		...(specOperation ? { specOperation } : {}),
	};
}

/**
 * The value an OpenAPI 3 parameter declares, by the same precedence `buildBody`
 * reads a request body with: the concrete `example` first, then the first entry of
 * `examples`, then what the schema says. An `example` is authored as "a realistic
 * value for this parameter" - written for exactly this - while a `default` only
 * describes what the server assumes when the parameter is absent, so it comes last.
 */
function declaredParamValue(param: JsonRecord, resolveRef: (r: string) => unknown): unknown {
	if (param.example !== undefined) return param.example;
	const named = firstNamedExample(param.examples);
	if (named !== undefined) return named;
	const schema = asRecord(deref(param.schema, resolveRef));
	return schema?.example ?? schema?.default;
}

/**
 * An operation's `responses` → saved example responses (issue #481).
 *
 * `op.responses` was visited by no code path before this: the parser sampled
 * request bodies and walked straight past the half of the spec that says what
 * comes back, so importing an API description produced requests with no
 * documented responses at all.
 *
 * Per response, the JSON media type's `example`, else the first entry of its
 * `examples` map, else a sample generated from its `schema` - the same
 * precedence `buildBody` uses for a request body, so the two halves of one
 * operation are filled in by the same rule. A response documenting no body
 * still imports: `204 No Content` is a real answer and a mock server has to be
 * able to give it.
 */
function buildExamples(
	responses: unknown,
	resolveRef: (r: string) => unknown,
	tally: SkipTally
): ExampleDraft[] {
	const map = asRecord(responses);
	if (!map) return [];
	const out: ExampleDraft[] = [];
	for (const [code, rawResponse] of Object.entries(map)) {
		const draft = responseExample(code, deref(rawResponse, resolveRef), tally, (response) => {
			const content = asRecord(response.content);
			if (!content) return undefined;
			const mediaType = findJsonMediaType(content);
			if (!mediaType) return undefined;
			const media = asRecord(content[mediaType]);
			if (!media) return undefined;
			const value =
				media.example ??
				firstNamedExample(media.examples) ??
				(media.schema ? sampleSchema(media.schema, resolveRef) : undefined);
			if (value === undefined) return undefined;
			return { body: exampleBodyText(value), contentType: mediaType };
		});
		if (draft) out.push(draft);
	}
	return out;
}

function findJsonMedia(content: JsonRecord): JsonRecord | undefined {
	if (content["application/json"]) return asRecord(content["application/json"]);
	const key = Object.keys(content).find(
		(k) => k.startsWith("application/json") || k.endsWith("+json")
	);
	return key ? asRecord(content[key]) : undefined;
}

function buildBody(requestBody: unknown, resolveRef: (r: string) => unknown): RequestBody {
	const ref = asStr(prop(requestBody, "$ref"));
	const content = asRecord(prop(ref ? resolveRef(ref) : requestBody, "content"));
	if (!content) return { mode: "none" };
	const jsonMedia = findJsonMedia(content);
	if (jsonMedia) {
		const sample =
			jsonMedia.example ??
			(jsonMedia.schema ? sampleSchema(jsonMedia.schema, resolveRef) : {});
		return { mode: "json", content: JSON.stringify(sample, null, 2) };
	}
	if (content["text/plain"]) return { mode: "text", content: "" };
	for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data"] as const) {
		if (content[ct]) {
			const multipart = ct === "multipart/form-data";
			const fields = schemaFormFields(prop(content[ct], "schema"), resolveRef).map((f) => {
				const entry = { key: f.name, value: "", enabled: true };
				// A spec names the upload, never the file - the part imports with no
				// path and the user attaches one. Left as a text row (what this did
				// until #425) it looked like a healthy field and sent nothing.
				// Only under multipart: urlencoded has no file form on the wire, so a
				// `format: binary` there is a spec that cannot mean what it says.
				return multipart && f.file ? importedFilePart(entry, "") : entry;
			});
			return { mode: multipart ? "form-data" : "x-www-form-urlencoded", fields };
		}
	}
	return { mode: "none" };
}
