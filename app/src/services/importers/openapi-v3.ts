/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { SpecOperation, HttpMethod, KeyValueEntry, RequestAuth, RequestBody } from "@/types";
import type {
	CollectionDraft,
	ExampleDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	ImportSource,
	RequestDraft,
} from "./types";
import { asArray, asRecord, asStr, prop, type JsonRecord } from "@/lib/json-node";
import { sampleSchema, schemaFormFields } from "./schema-sampler";
import { normalizeVars } from "./var-normalize";
import { mapOpenApiV3OAuth2 } from "./oauth2-import";
import {
	createRefResolver,
	declaredParamRow,
	deref,
	exampleBodyText,
	findJsonMediaType,
	firstNamedExample,
	resolvePathItem,
	responseExample,
	OperationFolders,
	SkipTally,
	createOperationIdentifier,
} from "./openapi-shared";
import { countExamples, importedFilePart, unattachedFileParts } from "./shared";

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

	parse(
		parsed: unknown,
		raw: string,
		_opts: ImportOptions,
		source: ImportSource = {}
	): ImportResult {
		const spec = asRecord(parsed) ?? {};
		const resolveRef = createRefResolver(spec);

		const primaryScheme = pickPrimaryScheme(spec);

		const folders = new OperationFolders(spec.tags);
		const tally = new SkipTally();
		const baseUrl = resolveServerUrl(asArray(spec.servers)[0], source.sourceUrl, tally);
		// One identifier for the whole document: it is what keeps a repeated
		// `operationId` off the second request that would otherwise claim it
		// (issue #715), which needs the memory of every id already stamped.
		const identify = createOperationIdentifier(tally);
		let requestCount = 0;

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
				const identity = identify(method, path, op.operationId);
				const req = buildOperation(
					method,
					path,
					op,
					resolveRef,
					pathParams,
					tally,
					identity
				);
				folders.place(req, path, op.tags);
			}
		}

		const root: CollectionDraft = {
			name: asStr(prop(spec.info, "title")) ?? "Imported API",
			description: asStr(prop(spec.info, "description")) ?? "",
			variables: baseUrl ? { baseUrl: { value: baseUrl, enabled: true } } : {},
			auth: schemeToAuth(primaryScheme),
			preRequestScript: "",
			postRequestScript: "",
			children: folders.children(),
			requests: folders.rootRequests(),
			// The document itself, so the import can store it and bind this
			// collection to it in the same atomic call (issue #637). `raw` and not
			// a re-serialization: the engine hashes the bytes it stores, and a
			// sync compares against that hash.
			// Neither index is beside it: the engine reads the document and
			// derives both the declared operations (issue #629, moved by #853)
			// and the response schemas (issue #628, moved by #860) from the very
			// bytes it stores, so one reader answers what a document declares.
			spec: {
				content: raw,
			},
		};

		return {
			collections: [root],
			environments: [],
			globals: {}, // a spec has no environment or globals concept
			meta: {
				format: this.formatName,
				requestCount,
				folderCount: folders.count(),
				...(folders.strategy() ? { folderStrategy: folders.strategy() } : {}),
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

/** A URL that already names its own scheme - `https:`, and any other. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** What is left of a `{token}` after substitution, which is what cannot resolve. */
const SERVER_TEMPLATE = /\{[^{}/]+\}/;

/**
 * `servers[0]` → the `{{baseUrl}}` every imported request is written against
 * (issue #719).
 *
 * Taken verbatim, that field produces a URL a request can never reach in two
 * ways, both silently. A Server Object may template its URL -
 * `{protocol}://{hostname}/api/v3` - and those single braces are **not** Vayu
 * variables (only the path goes through `normalizeVars`), so the literal
 * survived into every request line and failed at connect with nothing said. And
 * a server URL is allowed to be relative, in which case OpenAPI says it is
 * relative to where the document itself lives - which the parser knows only
 * because the factory now hands it over.
 *
 * So: substitute the defaults the document declares (the spec **requires** a
 * default on every server variable, so a complete document always resolves),
 * then resolve what is left against the source URL when it needs one. Anything
 * still unresolvable is kept exactly as written and counted - a base the user
 * can see is unfinished beats a host Vayu invented.
 */
export function resolveServerUrl(
	server: unknown,
	sourceUrl: string | undefined,
	tally: SkipTally
): string {
	const raw = asStr(prop(server, "url")) ?? "";
	if (!raw) return "";

	const variables = asRecord(prop(server, "variables")) ?? {};
	const substituted = raw.replace(/\{([^{}/]+)\}/g, (token, name: string) => {
		const declared = asRecord(variables[name]);
		if (declared?.default === undefined) return token;
		// A default is `string` per the spec; a number or boolean is what a
		// hand-written document produces and reads the same on the wire.
		const value = declared.default;
		return typeof value === "object" || value === null ? token : String(value);
	});

	if (SERVER_TEMPLATE.test(substituted)) {
		tally.add("unresolved_base_url");
		return substituted;
	}
	if (HAS_SCHEME.test(substituted)) return substituted;
	if (!sourceUrl) {
		// A pasted or file-picked document: there is no location to be relative
		// to, so the URL stays as written rather than being guessed at.
		tally.add("unresolved_base_url");
		return substituted;
	}
	try {
		return new URL(substituted, sourceUrl).toString();
	} catch {
		tally.add("unresolved_base_url");
		return substituted;
	}
}

function pickPrimaryScheme(spec: JsonRecord): unknown {
	const required = asRecord(asArray(spec.security)[0]);
	const reqName = required ? Object.keys(required)[0] : undefined;
	const schemes = asRecord(prop(spec.components, "securitySchemes")) ?? {};
	if (reqName && schemes[reqName]) return schemes[reqName];
	return Object.values(schemes)[0];
}

function buildOperation(
	method: string,
	path: string,
	op: JsonRecord,
	resolveRef: (r: string) => unknown,
	pathParams: unknown[],
	tally: SkipTally,
	/** The identity `parse` claimed for this operation - passed rather than
	 * re-derived, so the request and the declared-operation index can never
	 * disagree about which of two operations kept a repeated `operationId`
	 * (issue #715). */
	specOperation: SpecOperation | undefined
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
		} else if (resolved.in === "cookie") {
			// Vayu has no cookie-parameter row - a request's cookies come from the
			// jar - so the declaration is dropped. Counted rather than folded into a
			// `Cookie` header: the header is one joined value and a spec declares
			// these one at a time, so building it means inventing a merge the
			// document never wrote. Mapping them is a recorded non-goal (#719), and
			// the count is what keeps the drop out of the silent category.
			tally.add("cookie_param");
		}
		// `in: "path"` is deliberately not here and not counted: a path parameter is
		// already carried, as the `{{var}}` `normalizeVars` wrote into the URL.
	}
	const examples = buildExamples(op.responses, resolveRef, tally);
	return {
		name: asStr(op.summary) ?? asStr(op.operationId) ?? `${method.toUpperCase()} ${path}`,
		description: asStr(op.description) ?? "",
		method: method.toUpperCase() as HttpMethod,
		url: `{{baseUrl}}${normalizeVars(path, { pathTemplates: true })}`,
		params,
		headers,
		body: buildBody(op.requestBody, resolveRef, tally),
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

/**
 * An operation's `requestBody` → the request's body.
 *
 * @param tally counts a body the importer has no mode for (issue #719). An
 * `application/octet-stream`, `application/xml` or `image/*` body used to return
 * `{mode: "none"}` on the same path as *no body at all*, so GitHub's "Upload a
 * release asset" imported as a bodyless POST reporting 0 skipped. The two cases
 * are told apart by whether the document declared any media type: an operation
 * with no `requestBody` lost nothing and is not counted.
 */
function buildBody(
	requestBody: unknown,
	resolveRef: (r: string) => unknown,
	tally: SkipTally
): RequestBody {
	const ref = asStr(prop(requestBody, "$ref"));
	const content = asRecord(prop(ref ? resolveRef(ref) : requestBody, "content"));
	if (!content) return { mode: "none" };
	const unmapped = (): RequestBody => {
		if (Object.keys(content).length > 0) tally.add("unmapped_body");
		return { mode: "none" };
	};
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
	return unmapped();
}
