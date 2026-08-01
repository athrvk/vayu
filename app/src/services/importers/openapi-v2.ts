/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HttpMethod, KeyValueEntry, RequestAuth, RequestBody } from "@/types";
import type {
	CollectionDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	RequestDraft,
} from "./types";
import { asArray, asRecord, asStr, prop, type JsonRecord } from "@/lib/json-node";
import { sampleSchema } from "./schema-sampler";
import { normalizeVars } from "./var-normalize";
import { mapSwaggerOAuth2 } from "./oauth2-import";
import { resolvePathItem, SkipTally } from "./openapi-shared";

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

	parse(parsed: unknown, _raw: string, _opts: ImportOptions): ImportResult {
		const spec = asRecord(parsed) ?? {};
		const resolveRef = (ref: string): unknown => {
			const path = ref
				.replace(/^#\//, "")
				.split("/")
				.map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
			let cur: unknown = spec;
			for (const seg of path) cur = prop(cur, seg);
			return cur;
		};

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
		let requestCount = 0;

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
				const req = buildSwaggerOp(method, path, op, spec, resolveRef, pathParams, tally);
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

		const root: CollectionDraft = {
			name: asStr(prop(spec.info, "title")) ?? "Imported API",
			description: asStr(prop(spec.info, "description")) ?? "",
			variables: baseUrl ? { baseUrl: { value: baseUrl, enabled: true } } : {},
			auth: swaggerSchemeToAuth(primaryScheme),
			preRequestScript: "",
			postRequestScript: "",
			children: [...tagCollections.values()],
			requests: rootRequests,
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
				skipped: tally.items(),
				nonExecutableAuth: 0,
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
	tally: SkipTally
): RequestDraft {
	const params: KeyValueEntry[] = [];
	const headers: KeyValueEntry[] = [];
	let body: RequestBody = { mode: "none" };
	const formFields: KeyValueEntry[] = [];

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
				params.push({
					key: name,
					value: "",
					enabled: true,
					...(description ? { description } : {}),
				});
				break;
			case "header": {
				const lower = name.toLowerCase();
				if (lower !== "authorization" && lower !== "content-type")
					headers.push({ key: name, value: "", enabled: true });
				break;
			}
			case "body": {
				const sample = param.schema ? sampleSchema(param.schema, resolveRef) : {};
				body = isJsonConsume
					? { mode: "json", content: JSON.stringify(sample, null, 2) }
					: { mode: "text", content: JSON.stringify(sample, null, 2) };
				break;
			}
			case "formData":
				formFields.push({ key: name, value: "", enabled: true });
				break;
		}
	}
	if (formFields.length > 0) body = { mode: formMode, fields: formFields };

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
	};
}
