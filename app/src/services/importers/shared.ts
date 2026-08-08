/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { KeyValueEntry, RequestAuth, RequestBody, VariableValue } from "@/types";
import { asArray, asRecord, asStr, prop } from "@/lib/json-node";
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
