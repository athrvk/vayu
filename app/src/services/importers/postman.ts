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

/**
 * Collections never inherit, so `inherit`/absent become `none` - "nothing set
 * here", which a descendant's `inherit` walks past.
 *
 * An *explicit* `noauth` is the one case that must not collapse into that:
 * Postman treats a folder set to No Auth as terminating inheritance, so it maps
 * to Vayu's `noauth`, which `resolveAuthSource` stops at. Collapsing the two is
 * what let requests under a No Auth folder keep sending the root collection's
 * bearer token. The wire type is read here rather than in `mapPostmanAuth`
 * because the distinction is collection-only: on a request, `none` already means
 * send nothing.
 */
function collectionAuth(auth: any): Exclude<RequestAuth, { mode: "inherit" }> {
	if (auth?.type === "noauth") return { mode: "noauth" };
	const mapped = mapPostmanAuth(auth);
	return mapped.mode === "inherit" ? { mode: "none" } : mapped;
}

interface Ctx {
	opts: ImportOptions;
	requestCount: number;
	folderCount: number;
	nonExecutableAuth: number;
	skippedFileBody: number;
	skippedMalformed: number;
}

/**
 * Postman keeps a GraphQL body as `{ query, variables }` where `variables` is the
 * *text* of the Variables pane - a JSON-encoded string. GraphQL-over-HTTP wants a
 * map, and Vayu's own `serializeGraphQLBody` writes one, so the string is parsed
 * here; embedding it verbatim produced `"variables": "{\"limit\": 10}"` on the
 * wire and a double-escaped blob in the editor.
 *
 * A variables string that is not valid JSON is kept as-is rather than dropped:
 * the text is the only copy of the user's work, and an import that silently
 * deletes it is worse than one that shows it unparsed. Every other key rides
 * along untouched for the same reason.
 */
function graphqlContent(graphql: any): string {
	if (!graphql || typeof graphql !== "object") return JSON.stringify({});
	const out: Record<string, unknown> = { ...graphql };
	const vars = out.variables;
	if (typeof vars === "string") {
		if (!vars.trim()) {
			// Postman writes "" for an empty pane; Vayu omits the key entirely.
			delete out.variables;
		} else {
			try {
				out.variables = JSON.parse(vars);
			} catch {
				// Not JSON (mid-edit or templated) - preserve the raw text.
			}
		}
	}
	return JSON.stringify(out);
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
			return { mode: "graphql", content: graphqlContent(body.graphql) };
		case "file":
			ctx.skippedFileBody += 1;
			return { mode: "none" };
		default:
			return { mode: "none" };
	}
}

/**
 * `decodeURIComponent` that degrades instead of throwing. A `%` not followed by
 * two hex digits (`?discount=50%`, a LIKE pattern) is a `URIError`, and Postman
 * does not percent-validate a typed URL - so one such character used to abort the
 * whole file with "URI malformed" and no pointer to the offending request. The
 * still-encoded text is imported instead: unreadable is recoverable, absent is not.
 */
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** Split a `k=v&k2=v2` query string into entries, decoded and variable-normalized. */
function queryEntries(query: string): ReturnType<typeof mapKeyValues> {
	return query
		.split("&")
		.filter(Boolean)
		.map((pair: string) => {
			const eqIdx = pair.indexOf("=");
			const k = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
			const v = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
			return {
				key: safeDecode(k),
				value: normalizeVars(safeDecode(v)),
				enabled: true,
			};
		});
}

function pmUrl(url: any): { url: string; params: ReturnType<typeof mapKeyValues> } {
	if (typeof url === "string") {
		const qIdx = url.indexOf("?");
		if (qIdx === -1) return { url: normalizeVars(url), params: [] };
		return {
			url: normalizeVars(url.slice(0, qIdx)),
			params: queryEntries(url.slice(qIdx + 1)),
		};
	}
	const raw: string = typeof url?.raw === "string" ? url.raw : "";
	const qIdx = raw.indexOf("?");
	const base = qIdx === -1 ? raw : raw.slice(0, qIdx);
	const structured = mapKeyValues(Array.isArray(url?.query) ? url.query : undefined);
	// `query[]` wins when it has anything - it carries disabled state and
	// descriptions that `raw` cannot. Falling back to `raw` matters for
	// hand-written or script-generated collections that populate only `raw`: the
	// Postman app always writes both, so there was nothing to notice this drop.
	const params =
		structured.length > 0 || qIdx === -1 ? structured : queryEntries(raw.slice(qIdx + 1));
	return { url: normalizeVars(base), params };
}

/** `event[]` entries that are objects. A `null` in the array used to throw on `e.listen`. */
function pmEvents(node: any): any[] {
	return (Array.isArray(node?.event) ? node.event : []).filter(
		(e: unknown) => !!e && typeof e === "object"
	);
}

/**
 * Postman writes item-level `protocolProfileBehavior` exactly when the user
 * overrides redirect handling for that request - i.e. only where it matters. The
 * engine's `followRedirects` defaults to **true**, so an omitted `false` silently
 * follows the 3xx the request exists to inspect (the same reason both clients send
 * these fields on every execute rather than eliding defaults - see CLAUDE.md).
 *
 * Only well-typed values are read. A foreign file can carry anything here, and a
 * coerced `"false"` would be worse than the default: it reads as the user's
 * setting while being the opposite of it.
 */
function pmRedirects(item: any): Pick<RequestDraft, "followRedirects" | "maxRedirects"> {
	const behavior = item?.protocolProfileBehavior;
	if (!behavior || typeof behavior !== "object") return {};
	return {
		...(typeof behavior.followRedirects === "boolean"
			? { followRedirects: behavior.followRedirects }
			: {}),
		...(typeof behavior.maxRedirects === "number" && Number.isFinite(behavior.maxRedirects)
			? { maxRedirects: behavior.maxRedirects }
			: {}),
	};
}

function pmRequest(item: any, ctx: Ctx): RequestDraft {
	const rq = item.request ?? {};
	const { url, params } = pmUrl(rq.url);
	const auth = mapPostmanAuth(rq.auth);
	if (["digest", "aws", "ntlm"].includes(auth.mode)) ctx.nonExecutableAuth += 1;
	ctx.requestCount += 1;
	const events = pmEvents(item);
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
		...pmRedirects(item),
	};
}

function pmFolder(node: any, ctx: Ctx): CollectionDraft {
	const items: any[] = Array.isArray(node.item) ? node.item : [];
	const events = pmEvents(node);
	const children: CollectionDraft[] = [];
	const requests: RequestDraft[] = [];
	for (const child of items) {
		// A `null` or scalar entry - hand-edited or script-filtered JSON, which the
		// v2.0 detector's permissive fallback happily accepts - used to throw a bare
		// `TypeError: Cannot read properties of null` naming no item and no format,
		// failing an otherwise well-formed file whole. Count it instead, so the
		// preview shows the loss.
		if (!child || typeof child !== "object") {
			ctx.skippedMalformed += 1;
			continue;
		}
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
		skippedMalformed: 0,
	};
	const root = pmFolder(parsed, ctx);
	const skipped: SkippedItem[] = [];
	if (ctx.skippedFileBody > 0) skipped.push({ kind: "file_body", count: ctx.skippedFileBody });
	if (ctx.skippedMalformed > 0)
		skipped.push({ kind: "malformed_item", count: ctx.skippedMalformed });
	return {
		collections: [root],
		environments: [], // collection files don't embed environments
		globals: {}, // nor globals - both are separate exports, see postman-environment.ts
		meta: {
			format: formatName,
			requestCount: ctx.requestCount,
			folderCount: ctx.folderCount,
			environmentCount: 0,
			globalCount: 0,
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
