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

export function swaggerSchemeToAuth(scheme: any): Exclude<RequestAuth, { mode: "inherit" }> {
	if (!scheme || !scheme.type) return { mode: "none" };
	if (scheme.type === "basic") return { mode: "basic", username: "", password: "" };
	if (scheme.type === "apiKey") {
		return {
			mode: "apikey",
			key: scheme.name ?? "",
			value: "",
			in: scheme.in === "query" ? "query" : "header",
		};
	}
	if (scheme.type === "oauth2") return mapSwaggerOAuth2(scheme);
	return { mode: "none" };
}

export class OpenApiV2Parser implements ImportParser {
	readonly formatName = "OpenAPI 2.0 (Swagger)";
	readonly formatKey = "openapi-v2";

	detect(parsed: unknown, _raw: string): boolean {
		return (parsed as any)?.swagger === "2.0";
	}

	parse(parsed: unknown, _raw: string, _opts: ImportOptions): ImportResult {
		const spec = parsed as any;
		const resolveRef = (ref: string): unknown => {
			const path = ref
				.replace(/^#\//, "")
				.split("/")
				.map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
			let cur: any = spec;
			for (const seg of path) cur = cur?.[seg];
			return cur;
		};

		const scheme = (spec.schemes?.[0] as string) ?? "https";
		const basePath = spec.basePath && spec.basePath !== "/" ? spec.basePath : "";
		const baseUrl = spec.host ? `${scheme}://${spec.host}${basePath}` : "";

		const reqName = spec.security?.[0] ? Object.keys(spec.security[0])[0] : undefined;
		const defs = spec.securityDefinitions ?? {};
		const primaryScheme = (reqName && defs[reqName]) || Object.values(defs)[0];

		const tagCollections = new Map<string, CollectionDraft>();
		const rootRequests: RequestDraft[] = [];
		const tally = new SkipTally();
		let requestCount = 0;

		for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
			const pathItem = resolvePathItem(rawPathItem, resolveRef);
			if (!pathItem) {
				tally.add("malformed_spec");
				continue;
			}
			const pathParams = tally.params(pathItem.parameters);
			for (const method of HTTP_METHODS) {
				const op = (pathItem as any)[method];
				if (!op) continue;
				requestCount += 1;
				const req = buildSwaggerOp(method, path, op, spec, resolveRef, pathParams, tally);
				const tag = op.tags?.[0];
				if (tag) {
					if (!tagCollections.has(tag)) {
						const def = (spec.tags ?? []).find((t: any) => t.name === tag);
						tagCollections.set(tag, {
							name: tag,
							description: def?.description ?? "",
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
			name: spec.info?.title ?? "Imported API",
			description: spec.info?.description ?? "",
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
	op: any,
	spec: any,
	resolveRef: (r: string) => unknown,
	pathParams: unknown[],
	tally: SkipTally
): RequestDraft {
	const params: KeyValueEntry[] = [];
	const headers: KeyValueEntry[] = [];
	let body: RequestBody = { mode: "none" };
	const formFields: KeyValueEntry[] = [];

	const consumes: string[] = op.consumes ?? spec.consumes ?? [];
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
	const byKey = new Map<string, any>();
	for (const param of [...pathParams, ...tally.params(op.parameters)] as any[]) {
		const resolved = param?.$ref ? (resolveRef(param.$ref) as any) : param;
		if (!resolved || !resolved.in || !resolved.name) continue;
		byKey.set(`${resolved.in}:${resolved.name}`, resolved);
	}

	for (const param of byKey.values()) {
		switch (param.in) {
			case "query":
				params.push({
					key: param.name,
					value: "",
					enabled: true,
					...(param.description ? { description: param.description } : {}),
				});
				break;
			case "header": {
				const lower = String(param.name).toLowerCase();
				if (lower !== "authorization" && lower !== "content-type")
					headers.push({ key: param.name, value: "", enabled: true });
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
				formFields.push({ key: param.name, value: "", enabled: true });
				break;
		}
	}
	if (formFields.length > 0) body = { mode: formMode, fields: formFields };

	return {
		name: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`,
		description: op.description ?? "",
		method: method.toUpperCase() as HttpMethod,
		url: `{{baseUrl}}${normalizeVars(path)}`,
		params,
		headers,
		body,
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
	};
}
