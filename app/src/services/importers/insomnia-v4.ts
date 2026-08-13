/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { FormFieldEntry, HttpMethod, RequestAuth, RequestBody, VariableValue } from "@/types";
import type {
	CollectionDraft,
	EnvironmentDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	RequestDraft,
	SkippedItem,
} from "./types";
import { asRecord, asStr, prop, type JsonRecord } from "@/lib/json-node";
import {
	asString,
	importedFilePart,
	mapKeyValues,
	unattachedFileParts,
	withRequiredContentType,
} from "./shared";
import { toGraphQLEnvelope } from "@/lib/graphql/graphql-body";
import { normalizeVars } from "./var-normalize";
import { mapInsomniaOAuth2 } from "./oauth2-import";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
function toMethod(m: unknown): HttpMethod {
	const up = String(m ?? "GET").toUpperCase();
	return (METHODS.has(up) ? up : "GET") as HttpMethod;
}

interface Resource {
	_id: string;
	_type: string;
	parentId?: string;
	name?: string;
	description?: string;
	[k: string]: unknown;
}

/** Counters the tree walk accumulates so a nested helper can record a loss. */
interface Ctx {
	nonExec: number;
	/** Bodies Vayu cannot store at all: binary bodies and multipart file parts. */
	fileBody: number;
}

/**
 * Insomnia itself only emits arrays and string mime types, so any of the shapes
 * guarded below means a hand-edited or script-mangled file. `ImportModal` shows
 * `Error.message` verbatim, so name the format and the field rather than letting
 * a raw `TypeError`/`RangeError` surface as "Cannot read properties of undefined".
 */
function malformed(detail: string): Error {
	return new Error(`Malformed Insomnia export: ${detail}`);
}

/** A row array that may be absent but must not be another type. */
function rowsOrThrow(value: unknown, what: string): unknown[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw malformed(`${what} must be an array`);
	return value;
}

/** `{name,value,disabled,description}` row → the shape `mapKeyValues` reads. */
function kvRow(row: unknown): JsonRecord {
	const r = asRecord(row);
	const description = asStr(r?.description);
	return {
		key: r?.name,
		value: r?.value,
		disabled: r?.disabled,
		...(description ? { description } : {}),
	};
}

function insomniaAuth(auth: unknown, ctx: Ctx): RequestAuth {
	const node = asRecord(auth);
	if (!node || !node.type || node.disabled === true) {
		return node?.disabled === true ? { mode: "none" } : { mode: "inherit" };
	}
	switch (asStr(node.type)) {
		case "bearer":
			return insomniaBearer(node);
		case "basic":
			return {
				mode: "basic",
				username: normalizeVars(asString(node.username)),
				password: normalizeVars(asString(node.password)),
			};
		case "apikey":
			return {
				mode: "apikey",
				key: normalizeVars(asString(node.key)),
				value: normalizeVars(asString(node.value)),
				in: node.addTo === "queryParams" ? "query" : "header",
			};
		case "oauth2":
			return mapInsomniaOAuth2(node);
		case "digest":
		case "ntlm": {
			ctx.nonExec += 1;
			const { type, disabled: _disabled, ...config } = node;
			return { mode: type, config } as RequestAuth;
		}
		case "iam": {
			// Insomnia names AWS IAM auth "iam"; Vayu stores it as the "aws" config bag (not executed).
			ctx.nonExec += 1;
			const { type: _type, disabled: _disabled, ...config } = node;
			return { mode: "aws", config } as RequestAuth;
		}
		default:
			return { mode: "inherit" };
	}
}

/**
 * Insomnia sends `Authorization: <prefix> <token>`, where an empty PREFIX field
 * means "Bearer". Vayu's bearer mode always writes "Bearer", so a different
 * scheme (`Token`, `JWT`, ...) is preserved as an explicit Authorization header
 * instead of being silently rewritten - the engine sends an `apikey` header
 * value verbatim, so the wire bytes match what Insomnia would have sent.
 * A prefix that only differs in case is left on the native bearer mode: HTTP
 * auth schemes are case-insensitive (RFC 7235 §2.1).
 */
function insomniaBearer(auth: JsonRecord): RequestAuth {
	const token = normalizeVars(asString(auth.token));
	const prefix = normalizeVars(asString(auth.prefix)).trim();
	if (prefix !== "" && prefix.toLowerCase() !== "bearer") {
		return {
			mode: "apikey",
			key: "Authorization",
			value: `${prefix} ${token}`.trim(),
			in: "header",
		};
	}
	return { mode: "bearer", token };
}

/**
 * Insomnia's multipart params, files included.
 *
 * A file param keeps its path in `fileName` - the field is the *path* on the
 * exporting machine, not a declared part name - and its `value` is empty. One
 * with no path names no file, so it stays counted as skipped rather than
 * importing a part that could never be sent.
 */
function multipartFields(rows: unknown[], ctx: Ctx): FormFieldEntry[] {
	const out: FormFieldEntry[] = [];
	for (const row of rows) {
		if (prop(row, "type") !== "file") {
			out.push(...mapKeyValues([kvRow(row)]));
			continue;
		}
		const entry = mapKeyValues([kvRow(row)])[0];
		const path = asStr(prop(row, "fileName")) ?? "";
		if (!entry || path === "") {
			ctx.fileBody += 1;
			continue;
		}
		out.push(importedFilePart(entry, path));
	}
	return out;
}

function insomniaBody(body: unknown, ctx: Ctx): RequestBody {
	if (body == null) return { mode: "none" };
	const node = asRecord(body);
	if (!node) throw malformed("a request `body` must be an object");
	if (node.mimeType != null && typeof node.mimeType !== "string") {
		throw malformed("`body.mimeType` must be a string");
	}
	const mime = (node.mimeType ?? "").split(";")[0].trim();
	switch (mime) {
		case "application/json":
			return { mode: "json", content: normalizeVars(asString(node.text)) };
		case "text/plain":
			return { mode: "text", content: normalizeVars(asString(node.text)) };
		/*
		 * Insomnia's `application/graphql` body is usually the envelope
		 * (`{query, variables}`), but it may be the bare query document - and a
		 * bare document stored verbatim went on the wire as the whole HTTP body,
		 * which is not JSON and carries no `query` a GraphQL server can read.
		 * Nothing showed it: the editor's raw-string fallback renders a bare
		 * document exactly as it renders a healthy one. Normalizing here, at the
		 * one place the shape is known to be GraphQL, is what makes the panes and
		 * the wire agree. An envelope is passed through untouched.
		 */
		case "application/graphql":
			return {
				mode: "graphql",
				content: toGraphQLEnvelope(normalizeVars(asString(node.text))),
			};
		case "application/x-www-form-urlencoded":
			return {
				mode: "x-www-form-urlencoded",
				fields: mapKeyValues(rowsOrThrow(node.params, "`body.params`").map(kvRow)),
			};
		case "multipart/form-data": {
			const rows = rowsOrThrow(node.params, "`body.params`");
			return { mode: "form-data", fields: multipartFields(rows, ctx) };
		}
		default:
			return unlistedBody(node, ctx);
	}
}

/**
 * Any mime outside the five above. Insomnia's XML/YAML/CSV/"Other" bodies are
 * plain text in `body.text`, so they import as `text` rather than being dropped
 * (the sibling Postman parser's `rawBody()` fallback does the same). A binary
 * body carries a `fileName` and no text - that one Vayu genuinely cannot store,
 * so it is dropped and counted instead of vanishing.
 */
function unlistedBody(body: JsonRecord, ctx: Ctx): RequestBody {
	if (typeof body.text === "string" && body.text !== "") {
		return { mode: "text", content: normalizeVars(body.text) };
	}
	if (typeof body.fileName === "string" && body.fileName !== "") ctx.fileBody += 1;
	return { mode: "none" };
}

/**
 * Insomnia's per-request redirect choice is `"global" | "on" | "off"`, where
 * `"global"` defers to an app-level setting that follows redirects. Only an
 * explicit `"on"`/`"off"` is imported: the field stays absent otherwise, because
 * the engine's default is `true` and an omitted `false` would silently follow a
 * 3xx the user disabled. Insomnia has no per-request redirect *limit* (it is an
 * app-wide setting), so `maxRedirects` is never imported.
 */
function insomniaFollowRedirects(setting: unknown): boolean | undefined {
	if (setting === "off") return false;
	if (setting === "on") return true;
	return undefined;
}

export class InsomniaV4Parser implements ImportParser {
	readonly formatName = "Insomnia Export v4";
	readonly formatKey = "insomnia-v4";

	detect(parsed: unknown, _raw: string): boolean {
		const p = asRecord(parsed);
		return p?._type === "export" && p?.__export_format === 4;
	}

	parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
		const rawResources = prop(parsed, "resources");
		if (rawResources != null && !Array.isArray(rawResources)) {
			throw malformed("`resources` must be an array");
		}
		const resources: Resource[] = (rawResources ?? []) as Resource[];
		const byParent = new Map<string, Resource[]>();
		for (let i = 0; i < resources.length; i++) {
			const r = resources[i];
			if (r == null || typeof r !== "object") {
				throw malformed(`\`resources[${i}]\` must be an object`);
			}
			const key = r.parentId ?? "";
			if (!byParent.has(key)) byParent.set(key, []);
			byParent.get(key)!.push(r);
		}

		const skippedCounts: Record<string, number> = {};
		const ctx: Ctx = { nonExec: 0, fileBody: 0 };
		let requestCount = 0;
		let folderCount = 0;

		const buildRequest = (r: Resource): RequestDraft => {
			requestCount += 1;
			const label = `request "${r.name ?? r._id}"`;
			const followRedirects = insomniaFollowRedirects(r.settingFollowRedirects);
			const body = insomniaBody(r.body, ctx);
			return {
				name: r.name ?? "Untitled",
				description: r.description ?? "",
				method: toMethod(r.method),
				url: normalizeVars(asString(r.url)),
				params: mapKeyValues(
					rowsOrThrow(r.parameters, `${label}: \`parameters\``).map(kvRow)
				),
				headers: withRequiredContentType(
					mapKeyValues(rowsOrThrow(r.headers, `${label}: \`headers\``).map(kvRow)),
					body
				),
				body,
				auth: insomniaAuth(r.authentication, ctx),
				preRequestScript: opts.importScripts ? asString(r.preRequestScript) : "",
				postRequestScript: opts.importScripts ? asString(r.afterResponseScript) : "",
				...(followRedirects === undefined ? {} : { followRedirects }),
			};
		};

		// Insomnia cannot emit a cycle (`parentId` is a single edge), but a mangled
		// file can - and an unguarded walk answers that with a bare RangeError.
		const visited = new Set<string>();

		const buildCollection = (node: Resource, isWorkspace: boolean): CollectionDraft => {
			if (visited.has(node._id)) {
				throw malformed(`resource "${node._id}" appears twice in the folder tree`);
			}
			visited.add(node._id);
			const children: CollectionDraft[] = [];
			const requests: RequestDraft[] = [];
			for (const child of byParent.get(node._id) ?? []) {
				switch (child._type) {
					case "request_group":
						folderCount += 1;
						children.push(buildCollection(child, false));
						break;
					case "request":
						requests.push(buildRequest(child));
						break;
					case "grpc_request":
					case "websocket_request":
					case "api_spec":
					case "unit_test":
					case "unit_test_suite":
						skippedCounts[child._type] = (skippedCounts[child._type] ?? 0) + 1;
						break;
				}
			}
			return {
				name: node.name ?? "Imported",
				description: node.description ?? "",
				variables: isWorkspace ? toEnvVars(asRecord(node.environment) ?? {}) : {},
				auth: ((): Exclude<RequestAuth, { mode: "inherit" }> => {
					const a = insomniaAuth(node.authentication, ctx);
					return a.mode === "inherit" ? { mode: "none" } : a;
				})(),
				// Insomnia 9.3+ lets a folder carry scripts, and its v4 export writes
				// model fields verbatim - so these are the request-level key names. An
				// export that spells them differently reads as absent, i.e. as before.
				preRequestScript: opts.importScripts ? asString(node.preRequestScript) : "",
				postRequestScript: opts.importScripts ? asString(node.afterResponseScript) : "",
				children,
				requests,
			};
		};

		const workspaces = resources.filter((r) => r._type === "workspace");
		const collections = workspaces.map((w) => buildCollection(w, true));

		// Environments: base env (parentId=workspace) + sub-envs (parentId=base env). Flatten.
		const environments: EnvironmentDraft[] = [];
		if (opts.importEnvironments) {
			for (const w of workspaces) {
				const bases = (byParent.get(w._id) ?? []).filter((r) => r._type === "environment");
				for (const base of bases) {
					const baseVars = asRecord(base.data) ?? {};
					const subs = (byParent.get(base._id) ?? []).filter(
						(r) => r._type === "environment"
					);
					if (subs.length === 0) {
						environments.push({
							name: base.name ?? w.name ?? "Environment",
							description: "",
							variables: toEnvVars(baseVars),
						});
					} else {
						for (const sub of subs) {
							environments.push({
								name: sub.name ?? "Environment",
								description: "",
								variables: toEnvVars({
									...baseVars,
									...(asRecord(sub.data) ?? {}),
								}),
							});
						}
					}
				}
			}
		}

		if (ctx.fileBody > 0) skippedCounts.file_body = ctx.fileBody;

		const skipped: SkippedItem[] = Object.entries(skippedCounts).map(([kind, count]) => ({
			kind: (kind === "grpc_request"
				? "grpc"
				: kind === "websocket_request"
					? "websocket"
					: kind === "unit_test_suite"
						? "unit_test"
						: kind) as SkippedItem["kind"],
			count,
		}));

		return {
			collections,
			environments,
			globals: {}, // Insomnia has no globals scope; workspace envs map to environments
			meta: {
				format: this.formatName,
				requestCount,
				folderCount,
				environmentCount: environments.length,
				globalCount: 0,
				// Insomnia v4 exports carry no saved responses - the format has no
				// concept of one, so this is 0 by absence rather than by drop.
				exampleCount: 0,
				skipped,
				nonExecutableAuth: ctx.nonExec,
				unattachedFileParts: unattachedFileParts(collections),
			},
		};
	}
}

/** Insomnia env `data` (may hold non-string values) → Vayu VariableValue record. */
function toEnvVars(data: Record<string, unknown>): Record<string, VariableValue> {
	const out: Record<string, VariableValue> = {};
	for (const [k, v] of Object.entries(data)) {
		out[k] = { value: normalizeVars(asString(v)), enabled: true };
	}
	return out;
}
