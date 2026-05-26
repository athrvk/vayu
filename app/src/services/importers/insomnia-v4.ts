/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HttpMethod, RequestAuth, RequestBody, VariableValue } from "@/types";
import type {
  CollectionDraft,
  EnvironmentDraft,
  ImportOptions,
  ImportParser,
  ImportResult,
  RequestDraft,
  SkippedItem,
} from "./types";
import { asString, mapKeyValues } from "./shared";
import { normalizeVars } from "./var-normalize";

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

function insomniaAuth(auth: any, ctx: { nonExec: number }): RequestAuth {
  if (!auth || !auth.type || auth.disabled === true) {
    return auth?.disabled === true ? { mode: "none" } : { mode: "inherit" };
  }
  switch (auth.type) {
    case "bearer":
      return { mode: "bearer", token: normalizeVars(asString(auth.token)) };
    case "basic":
      return { mode: "basic", username: normalizeVars(asString(auth.username)), password: normalizeVars(asString(auth.password)) };
    case "apikey":
      return { mode: "apikey", key: normalizeVars(asString(auth.key)), value: normalizeVars(asString(auth.value)), in: auth.addTo === "queryParams" ? "query" : "header" };
    case "oauth2":
    case "digest": {
      ctx.nonExec += 1;
      const { type: _type, disabled: _disabled, ...config } = auth;
      return { mode: auth.type, config } as RequestAuth;
    }
    default:
      return { mode: "inherit" };
  }
}

function insomniaBody(body: any): RequestBody {
  const mime = (body?.mimeType ?? "").split(";")[0].trim();
  switch (mime) {
    case "application/json":
      return { mode: "json", content: normalizeVars(asString(body.text)) };
    case "text/plain":
      return { mode: "text", content: normalizeVars(asString(body.text)) };
    case "application/graphql":
      return { mode: "graphql", content: normalizeVars(asString(body.text)) };
    case "application/x-www-form-urlencoded":
      return { mode: "x-www-form-urlencoded", fields: mapKeyValues((body.params ?? []).map((p: any) => ({ key: p.name, value: p.value, disabled: p.disabled }))) };
    case "multipart/form-data": {
      const text = (body.params ?? []).filter((p: any) => p.type !== "file");
      return { mode: "form-data", fields: mapKeyValues(text.map((p: any) => ({ key: p.name, value: p.value, disabled: p.disabled }))) };
    }
    default:
      return { mode: "none" };
  }
}

export class InsomniaV4Parser implements ImportParser {
  readonly formatName = "Insomnia Export v4";
  readonly formatKey = "insomnia-v4";

  detect(parsed: unknown, _raw: string): boolean {
    const p = parsed as any;
    return p?._type === "export" && p?.__export_format === 4;
  }

  parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
    const resources: Resource[] = ((parsed as any)?.resources ?? []) as Resource[];
    const byParent = new Map<string, Resource[]>();
    for (const r of resources) {
      const key = r.parentId ?? "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(r);
    }

    const skippedCounts: Record<string, number> = {};
    const authCtx = { nonExec: 0 };
    let requestCount = 0;
    let folderCount = 0;

    const buildRequest = (r: Resource): RequestDraft => {
      requestCount += 1;
      return {
        name: r.name ?? "Untitled",
        description: r.description ?? "",
        method: toMethod(r.method),
        url: normalizeVars(asString(r.url)),
        params: mapKeyValues(((r.parameters as any[]) ?? []).map((p) => ({ key: p.name, value: p.value, disabled: p.disabled }))),
        headers: mapKeyValues(((r.headers as any[]) ?? []).map((h) => ({ key: h.name, value: h.value, disabled: h.disabled }))),
        body: insomniaBody(r.body),
        auth: insomniaAuth(r.authentication, authCtx),
        preRequestScript: opts.importScripts ? asString(r.preRequestScript) : "",
        postRequestScript: opts.importScripts ? asString(r.afterResponseScript) : "",
      };
    };

    const buildCollection = (node: Resource, isWorkspace: boolean): CollectionDraft => {
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
        variables: isWorkspace ? toEnvVars((node.environment as any) ?? {}) : {},
        auth: ((): Exclude<RequestAuth, { mode: "inherit" }> => {
          const a = insomniaAuth((node as any).authentication, authCtx);
          return a.mode === "inherit" ? { mode: "none" } : a;
        })(),
        preRequestScript: "",
        postRequestScript: "",
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
          const baseVars = (base.data as Record<string, unknown>) ?? {};
          const subs = (byParent.get(base._id) ?? []).filter((r) => r._type === "environment");
          if (subs.length === 0) {
            environments.push({ name: base.name ?? w.name ?? "Environment", description: "", variables: toEnvVars(baseVars) });
          } else {
            for (const sub of subs) {
              environments.push({
                name: sub.name ?? "Environment",
                description: "",
                variables: toEnvVars({ ...baseVars, ...((sub.data as Record<string, unknown>) ?? {}) }),
              });
            }
          }
        }
      }
    }

    const skipped: SkippedItem[] = Object.entries(skippedCounts).map(([kind, count]) => ({
      kind: (kind === "grpc_request" ? "grpc" : kind === "websocket_request" ? "websocket" : kind === "unit_test_suite" ? "unit_test" : kind) as SkippedItem["kind"],
      count,
    }));

    return {
      collections,
      environments,
      meta: {
        format: this.formatName,
        requestCount,
        folderCount,
        environmentCount: environments.length,
        skipped,
        nonExecutableAuth: authCtx.nonExec,
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
