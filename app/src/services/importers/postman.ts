/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HttpMethod, RequestAuth, RequestBody } from "@/types";
import type {
	CollectionDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	RequestDraft,
	SkippedItem,
} from "./types";
import { joinExec, mapKeyValues, mapPostmanAuth, rawBody, toVarRecord } from "./shared";
import { normalizeVars } from "./var-normalize";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
function toMethod(m: unknown): HttpMethod {
	const up = String(m ?? "GET").toUpperCase();
	return (METHODS.has(up) ? up : "GET") as HttpMethod;
}

/** Collections never inherit: inherit/noauth/absent → {mode:none}. */
function collectionAuth(auth: any): Exclude<RequestAuth, { mode: "inherit" }> {
	const mapped = mapPostmanAuth(auth);
	return mapped.mode === "inherit" ? { mode: "none" } : mapped;
}

interface Ctx {
	opts: ImportOptions;
	requestCount: number;
	folderCount: number;
	nonExecutableAuth: number;
	skippedFileBody: number;
}

function pmBody(body: any, ctx: Ctx): RequestBody {
	if (!body || !body.mode) return { mode: "none" };
	switch (body.mode) {
		case "raw":
			return rawBody(body.raw ?? "", body.options?.raw?.language);
		case "urlencoded":
			return { mode: "x-www-form-urlencoded", fields: mapKeyValues(body.urlencoded) };
		case "formdata": {
			const textFields = (body.formdata ?? []).filter((f: any) => f.type !== "file");
			const fileCount = (body.formdata ?? []).length - textFields.length;
			ctx.skippedFileBody += fileCount;
			return { mode: "form-data", fields: mapKeyValues(textFields) };
		}
		case "graphql":
			return { mode: "graphql", content: JSON.stringify(body.graphql ?? {}) };
		case "file":
			ctx.skippedFileBody += 1;
			return { mode: "none" };
		default:
			return { mode: "none" };
	}
}

function pmUrl(url: any): { url: string; params: ReturnType<typeof mapKeyValues> } {
	if (typeof url === "string") {
		const qIdx = url.indexOf("?");
		if (qIdx === -1) return { url: normalizeVars(url), params: [] };
		const base = url.slice(0, qIdx);
		const params = url
			.slice(qIdx + 1)
			.split("&")
			.filter(Boolean)
			.map((pair: string) => {
				const eqIdx = pair.indexOf("=");
				const k = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
				const v = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
				return {
					key: decodeURIComponent(k),
					value: normalizeVars(decodeURIComponent(v)),
					enabled: true,
				};
			});
		return { url: normalizeVars(base), params };
	}
	const raw: string = url?.raw ?? "";
	const base = raw.includes("?") ? raw.slice(0, raw.indexOf("?")) : raw;
	return { url: normalizeVars(base), params: mapKeyValues(url?.query) };
}

function pmRequest(item: any, ctx: Ctx): RequestDraft {
	const rq = item.request ?? {};
	const { url, params } = pmUrl(rq.url);
	const auth = mapPostmanAuth(rq.auth);
	if (["digest", "aws", "ntlm"].includes(auth.mode)) ctx.nonExecutableAuth += 1;
	ctx.requestCount += 1;
	const events: any[] = Array.isArray(item.event) ? item.event : [];
	const pre = events.find((e) => e.listen === "prerequest");
	const post = events.find((e) => e.listen === "test");
	return {
		name: item.name ?? "Untitled",
		description:
			typeof rq.description === "string" ? rq.description : (rq.description?.content ?? ""),
		method: toMethod(rq.method),
		url,
		params,
		headers: mapKeyValues(rq.header),
		body: pmBody(rq.body, ctx),
		auth,
		preRequestScript: ctx.opts.importScripts ? joinExec(pre) : "",
		postRequestScript: ctx.opts.importScripts ? joinExec(post) : "",
	};
}

function pmFolder(node: any, ctx: Ctx): CollectionDraft {
	const items: any[] = Array.isArray(node.item) ? node.item : [];
	const events: any[] = Array.isArray(node.event) ? node.event : [];
	const children: CollectionDraft[] = [];
	const requests: RequestDraft[] = [];
	for (const child of items) {
		if (Array.isArray(child.item)) {
			ctx.folderCount += 1;
			children.push(pmFolder(child, ctx));
		} else if (child.request) {
			requests.push(pmRequest(child, ctx));
		}
	}
	const descObj = node.info?.description ?? node.description;
	return {
		name: node.info?.name ?? node.name ?? "Imported Collection",
		description: typeof descObj === "string" ? descObj : (descObj?.content ?? ""),
		variables: toVarRecord(node.variable),
		auth: collectionAuth(node.auth),
		preRequestScript: ctx.opts.importScripts
			? joinExec(events.find((e) => e.listen === "prerequest"))
			: "",
		postRequestScript: ctx.opts.importScripts
			? joinExec(events.find((e) => e.listen === "test"))
			: "",
		children,
		requests,
	};
}

function parsePostman(parsed: any, opts: ImportOptions, formatName: string): ImportResult {
	const ctx: Ctx = {
		opts,
		requestCount: 0,
		folderCount: 0,
		nonExecutableAuth: 0,
		skippedFileBody: 0,
	};
	const root = pmFolder(parsed, ctx);
	const skipped: SkippedItem[] = [];
	if (ctx.skippedFileBody > 0) skipped.push({ kind: "file_body", count: ctx.skippedFileBody });
	return {
		collections: [root],
		environments: [], // collection files don't embed environments
		meta: {
			format: formatName,
			requestCount: ctx.requestCount,
			folderCount: ctx.folderCount,
			environmentCount: 0,
			skipped,
			nonExecutableAuth: ctx.nonExecutableAuth,
		},
	};
}

export class PostmanV21Parser implements ImportParser {
	readonly formatName = "Postman Collection v2.1";
	readonly formatKey = "postman-v21";
	detect(parsed: unknown, _raw: string): boolean {
		const schema = (parsed as any)?.info?.schema;
		return typeof schema === "string" && schema.includes("v2.1.0");
	}
	parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
		return parsePostman(parsed, opts, this.formatName);
	}
}

export class PostmanV20Parser implements ImportParser {
	readonly formatName = "Postman Collection v2.0";
	readonly formatKey = "postman-v20";
	detect(parsed: unknown, _raw: string): boolean {
		const p = parsed as any;
		const schema = p?.info?.schema;
		if (typeof schema === "string" && schema.includes("v2.0.0")) return true;
		// info + item present but no schema field at all → treat as v2.0.
		return !!p?.info && Array.isArray(p?.item) && schema == null;
	}
	parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
		// v2.0 URLs are always strings; pmUrl already handles the string form.
		return parsePostman(parsed, opts, this.formatName);
	}
}
