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
import { defaultOAuth2Config } from "@/services/oauth/defaults";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** Map an OpenAPI 3 securityScheme to a concrete collection-level auth (empty secrets). */
export function schemeToAuth(scheme: any): Exclude<RequestAuth, { mode: "inherit" }> {
	if (!scheme || !scheme.type) return { mode: "none" };
	if (scheme.type === "http" && scheme.scheme === "bearer") return { mode: "bearer", token: "" };
	if (scheme.type === "http" && scheme.scheme === "basic")
		return { mode: "basic", username: "", password: "" };
	if (scheme.type === "apiKey") {
		return {
			mode: "apikey",
			key: scheme.name ?? "",
			value: "",
			in: scheme.in === "query" ? "query" : "header",
		};
	}
	if (scheme.type === "oauth2")
		return { mode: "oauth2", config: defaultOAuth2Config() }; // TODO(PR5): map flows
	return { mode: "none" };
}

export class OpenApiV3Parser implements ImportParser {
	readonly formatName = "OpenAPI 3.0";
	readonly formatKey = "openapi-v3";

	detect(parsed: unknown, _raw: string): boolean {
		const v = (parsed as any)?.openapi;
		return typeof v === "string" && v.startsWith("3.");
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

		const baseUrl = spec.servers?.[0]?.url ?? "";
		const primaryScheme = pickPrimaryScheme(spec);

		const tagCollections = new Map<string, CollectionDraft>();
		const rootRequests: RequestDraft[] = [];
		let requestCount = 0;

		for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
			const pathParams = (pathItem as any)?.parameters ?? [];
			for (const method of HTTP_METHODS) {
				const op = (pathItem as any)?.[method];
				if (!op) continue;
				requestCount += 1;
				const req = buildOperation(method, path, op, resolveRef, pathParams);
				const tag = op.tags?.[0];
				if (tag) {
					if (!tagCollections.has(tag))
						tagCollections.set(tag, makeTagCollection(spec, tag));
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
			auth: schemeToAuth(primaryScheme),
			preRequestScript: "",
			postRequestScript: "",
			children: [...tagCollections.values()],
			requests: rootRequests,
		};

		return {
			collections: [root],
			environments: [],
			meta: {
				format: this.formatName,
				requestCount,
				folderCount: tagCollections.size,
				environmentCount: 0,
				skipped: [],
				nonExecutableAuth: primaryScheme?.type === "oauth2" ? 1 : 0,
			},
		};
	}
}

function pickPrimaryScheme(spec: any): any {
	const reqName = spec.security?.[0] ? Object.keys(spec.security[0])[0] : undefined;
	const schemes = spec.components?.securitySchemes ?? {};
	if (reqName && schemes[reqName]) return schemes[reqName];
	const first = Object.values(schemes)[0];
	return first;
}

function makeTagCollection(spec: any, tag: string): CollectionDraft {
	const def = (spec.tags ?? []).find((t: any) => t.name === tag);
	return {
		name: tag,
		description: def?.description ?? "",
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
	op: any,
	resolveRef: (r: string) => unknown,
	pathParams: any[] = []
): RequestDraft {
	const params: KeyValueEntry[] = [];
	const headers: KeyValueEntry[] = [];
	const byKey = new Map<string, any>();
	for (const param of [...pathParams, ...(op.parameters ?? [])]) {
		const resolved = param?.$ref ? (resolveRef(param.$ref) as any) : param;
		if (!resolved || !resolved.in || !resolved.name) continue;
		byKey.set(`${resolved.in}:${resolved.name}`, resolved); // later (operation) wins
	}
	for (const resolved of byKey.values()) {
		if (resolved.in === "query") {
			params.push({
				key: resolved.name,
				value: "",
				enabled: true,
				...(resolved.description ? { description: resolved.description } : {}),
			});
		} else if (resolved.in === "header") {
			const lower = String(resolved.name).toLowerCase();
			if (lower === "authorization" || lower === "content-type") continue;
			headers.push({ key: resolved.name, value: "", enabled: true });
		}
	}
	return {
		name: op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`,
		description: op.description ?? "",
		method: method.toUpperCase() as HttpMethod,
		url: `{{baseUrl}}${normalizeVars(path)}`,
		params,
		headers,
		body: buildBody(op.requestBody, resolveRef),
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
	};
}

function findJsonMedia(content: Record<string, any>): any {
	if (content["application/json"]) return content["application/json"];
	const key = Object.keys(content).find(
		(k) => k.startsWith("application/json") || k.endsWith("+json")
	);
	return key ? content[key] : undefined;
}

function buildBody(requestBody: any, resolveRef: (r: string) => unknown): RequestBody {
	const content = (requestBody?.$ref ? (resolveRef(requestBody.$ref) as any) : requestBody)
		?.content;
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
			const props = content[ct].schema?.properties ?? {};
			const fields = Object.keys(props).map((k) => ({ key: k, value: "", enabled: true }));
			return {
				mode: ct === "multipart/form-data" ? "form-data" : "x-www-form-urlencoded",
				fields,
			};
		}
	}
	return { mode: "none" };
}
