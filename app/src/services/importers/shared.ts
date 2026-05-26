/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { KeyValueEntry, RequestAuth, RequestBody, VariableValue } from "@/types";
import { normalizeVars } from "./var-normalize";

/** Coerce any scalar to its string form (Vayu stores all values as strings). */
export function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Postman/Insomnia variable arrays → Vayu VariableValue record. */
export function toVarRecord(
  vars: Array<{ key: string; value?: unknown; enabled?: boolean; disabled?: boolean }> | undefined
): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const v of vars ?? []) {
    if (!v || !v.key) continue;
    const enabled = v.disabled != null ? !v.disabled : v.enabled != null ? v.enabled : true;
    out[v.key] = { value: normalizeVars(asString(v.value)), enabled };
  }
  return out;
}

/** Postman header/query/urlencoded arrays → KeyValueEntry[]. Preserves disabled + duplicates. */
export function mapKeyValues(
  rows: Array<{ key?: string; value?: unknown; disabled?: boolean; description?: string }> | undefined
): KeyValueEntry[] {
  return (rows ?? [])
    .filter((r) => r && r.key)
    .map((r) => ({
      key: r.key as string,
      value: normalizeVars(asString(r.value)),
      enabled: r.disabled !== true,
      ...(r.description ? { description: r.description } : {}),
    }));
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
export function mapPostmanAuth(auth: any): RequestAuth {
  if (!auth || !auth.type) return { mode: "inherit" };
  const type = auth.type as string;
  const d = authDetail(auth[type]);
  switch (type) {
    case "bearer":
      return { mode: "bearer", token: normalizeVars(d.token ?? "") };
    case "basic":
      return { mode: "basic", username: normalizeVars(d.username ?? ""), password: normalizeVars(d.password ?? "") };
    case "apikey":
      return {
        mode: "apikey",
        key: normalizeVars(d.key ?? ""),
        value: normalizeVars(d.value ?? ""),
        in: d.in === "query" ? "query" : "header",
      };
    case "oauth2":
    case "digest":
    case "aws":
    case "ntlm":
      return { mode: type, config: d } as RequestAuth;
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

/** Postman event entry → joined script string. */
export function joinExec(event: any): string {
  const exec = event?.script?.exec;
  if (Array.isArray(exec)) return exec.join("\n");
  if (typeof exec === "string") return exec;
  return "";
}
