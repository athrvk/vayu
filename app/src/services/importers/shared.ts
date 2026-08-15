/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	FormFieldEntry,
	KeyValueEntry,
	RequestAuth,
	RequestBody,
	VariableValue,
} from "@/types";
import type { CollectionDraft } from "./types";
import { asArray, asRecord, asStr, prop } from "@/lib/json-node";
import { fileBaseName } from "@/lib/file-path";
import { normalizeVars } from "./var-normalize";
import { mapPostmanOAuth2 } from "./oauth2-import";
import {
	CONTENT_TYPE,
	contentTypeToAdd,
} from "@/modules/request-builder/components/RequestTabs/panels/body/content-type";

/** Coerce any scalar to its string form (Vayu stores all values as strings). */
export function asString(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return v;
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

/**
 * Postman/Insomnia variable arrays → Vayu VariableValue record.
 *
 * `type` is Postman's per-variable kind. Only `"secret"` is meaningful to Vayu
 * (it maps to `VariableValue.secret`); the rest describe a value type Vayu does
 * not store, since every value is a string. The flag is omitted rather than set
 * to `false` so a non-secret variable serialises the same as before.
 */
export function toVarRecord(vars: unknown): Record<string, VariableValue> {
	const out: Record<string, VariableValue> = {};
	for (const entry of asArray(vars)) {
		const v = asRecord(entry);
		if (!v || !v.key) continue;
		const enabled = v.disabled != null ? !v.disabled : v.enabled != null ? !!v.enabled : true;
		out[asString(v.key)] = {
			value: normalizeVars(asString(v.value)),
			enabled,
			...(v.type === "secret" ? { secret: true } : {}),
		};
	}
	return out;
}

/** Postman header/query/urlencoded arrays → KeyValueEntry[]. Preserves disabled + duplicates. */
export function mapKeyValues(rows: unknown): KeyValueEntry[] {
	const out: KeyValueEntry[] = [];
	for (const row of asArray(rows)) {
		const r = asRecord(row);
		if (!r || !r.key) continue;
		out.push({
			key: asString(r.key),
			value: normalizeVars(asString(r.value)),
			enabled: r.disabled !== true,
			...(r.description ? { description: asString(r.description) } : {}),
		});
	}
	return out;
}

/**
 * An imported multipart part that uploads a file.
 *
 * The path is kept exactly as the source file wrote it, and a row that has one
 * is marked **unresolved**: it names a file on whoever's machine produced the
 * export, so it will usually not exist here. That flag is what the editor's
 * warning reads; picking a file clears it. Dropping the part instead - which
 * both importers did until issue #393 - turned an upload into a request that
 * silently posted nothing.
 *
 * A source that declares a file part *without* naming a file - an OpenAPI spec
 * documents the upload, never the path (#425) - passes `src: ""`, and that row
 * is **not** unresolved: the flag warns that something which looks filled in
 * cannot be sent, and a row showing "Choose file" makes no such claim. It is
 * the same shape the editor produces when a user turns a row into a file part,
 * which is exactly what this is: an upload the user still has to complete.
 *
 * `value` is cleared because a file part has no typed value; whatever the
 * source stored in that slot (Insomnia leaves it "") is not sent.
 */
export function importedFilePart(
	entry: KeyValueEntry,
	src: string,
	contentType?: string
): FormFieldEntry {
	return {
		...entry,
		value: "",
		type: "file",
		src,
		...(fileBaseName(src) ? { fileName: fileBaseName(src) } : {}),
		...(contentType ? { contentType } : {}),
		...(src ? { unresolved: true } : {}),
	};
}

/**
 * File parts the import produced that name no file yet, counted for the preview.
 *
 * Derived from the drafts rather than tallied while building them: the count and
 * the rows cannot then disagree, and a parser that starts emitting such a row
 * gets a truthful number without remembering to increment anything. Only the
 * OpenAPI parsers produce any today - Postman and Insomnia file rows always
 * carry a path, and one without is skipped as a `file_body` instead.
 */
export function unattachedFileParts(collections: CollectionDraft[]): number {
	let count = 0;
	for (const collection of collections) {
		for (const request of collection.requests) {
			if (request.body.mode !== "form-data") continue;
			count += request.body.fields.filter((f) => f.type === "file" && !f.src).length;
		}
		count += unattachedFileParts(collection.children);
	}
	return count;
}

/**
 * Saved example responses across a whole draft tree (issue #481), for
 * `ImportMeta.exampleCount`.
 *
 * Read off the drafts rather than tallied as the parser walks, exactly like
 * `unattachedFileParts` above: a counter incremented at the mapping site can
 * drift from what the drafts actually carry, and this number is what the
 * preview promises the user is about to be imported.
 */
export function countExamples(collections: CollectionDraft[]): number {
	let count = 0;
	for (const collection of collections) {
		for (const request of collection.requests) {
			count += request.examples?.length ?? 0;
		}
		count += countExamples(collection.children);
	}
	return count;
}

/** Read a Postman auth detail array/object into a flat {key:value} map (handles v2.1 + v2.0). */
function authDetail(node: unknown): Record<string, string> {
	if (Array.isArray(node)) {
		const m: Record<string, string> = {};
		for (const e of node) if (e && e.key) m[e.key] = asString(e.value);
		return m;
	}
	if (node && typeof node === "object") {
		const m: Record<string, string> = {};
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) m[k] = asString(v);
		return m;
	}
	return {};
}

/** Map a Postman `auth` object (collection/folder/request) to a Vayu RequestAuth. */
export function mapPostmanAuth(auth: unknown): RequestAuth {
	const node = asRecord(auth);
	if (!node || !node.type) return { mode: "inherit" };
	// A `type` that is not a string names no scheme, so nothing can be sent for it.
	const type = asStr(node.type);
	if (!type) return { mode: "none" };
	const d = authDetail(node[type]);
	switch (type) {
		case "bearer":
			return { mode: "bearer", token: normalizeVars(d.token ?? "") };
		case "basic":
			return {
				mode: "basic",
				username: normalizeVars(d.username ?? ""),
				password: normalizeVars(d.password ?? ""),
			};
		case "apikey":
			return {
				mode: "apikey",
				key: normalizeVars(d.key ?? ""),
				value: normalizeVars(d.value ?? ""),
				in: d.in === "query" ? "query" : "header",
			};
		case "oauth2":
			return mapPostmanOAuth2(d);
		// AWS Signature is `awsv4` on the wire (the v2.1.0/v2.0.0 schema's enum);
		// Vayu's internal mode is `aws`, which Insomnia's `iam` also maps to. The
		// two names diverge, so the mode is written out instead of reusing `type` -
		// matching on `"aws"` here is what silently dropped every real SigV4 export.
		case "awsv4":
			return { mode: "aws", config: d };
		case "digest":
		case "ntlm":
			return { mode: type, config: d } as RequestAuth;
		case "inherit":
			return { mode: "inherit" };
		case "noauth":
			return { mode: "none" };
		default:
			return { mode: "none" };
	}
}

/** Postman raw body → Vayu RequestBody. */
export function rawBody(content: string, language: string | undefined): RequestBody {
	if (language === "json") return { mode: "json", content };
	if (language === "text") return { mode: "text", content };
	// Postman's raw-body language for an XML document. Landing it on the `xml`
	// mode is what gets the imported request its `application/xml`:
	// `withRequiredContentType` asks the mode, and `text` requires nothing - so
	// before this, an imported SOAP request went out as libcurl's
	// `x-www-form-urlencoded`, the same failure imported GraphQL had.
	if (language === "xml") return { mode: "xml", content };
	// No explicit language: sniff JSON.
	try {
		JSON.parse(content);
		return { mode: "json", content };
	} catch {
		return { mode: "text", content };
	}
}

/**
 * The imported headers, plus the Content-Type this body cannot go without.
 *
 * The request builder adds `application/json` when you *pick* GraphQL, and only
 * then - so an imported GraphQL request had no Content-Type at all and went out
 * as libcurl's default `application/x-www-form-urlencoded`, which most GraphQL
 * servers answer with a 400. The failure looks identical to a working request
 * in every pane, since the header the user would look for is simply absent.
 *
 * The rule itself is `contentTypeToAdd`, not a copy of it: an explicitly
 * imported Content-Type wins (including a deliberate `application/graphql`),
 * and a disabled row does not count as declaring one.
 */
export function withRequiredContentType(
	headers: KeyValueEntry[],
	body: RequestBody
): KeyValueEntry[] {
	const required = contentTypeToAdd(body.mode, headers);
	return required ? [...headers, { key: CONTENT_TYPE, value: required, enabled: true }] : headers;
}

/** Postman event entry → joined script string. */
export function joinExec(event: unknown): string {
	const exec = prop(prop(event, "script"), "exec");
	if (Array.isArray(exec)) return exec.join("\n");
	return asStr(exec) ?? "";
}
