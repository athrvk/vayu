import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostmanV21Parser } from "./postman";

const raw = readFileSync(join(__dirname, "__fixtures__/postman-v21.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("PostmanV21Parser", () => {
  const p = new PostmanV21Parser();

  it("detects v2.1 by schema", () => {
    expect(p.detect(parsed, raw)).toBe(true);
    expect(p.detect({ info: { schema: "v2.0.0" } }, "")).toBe(false);
  });

  it("builds a root collection with name, vars, auth, script", () => {
    const r = p.parse(parsed, raw, opts);
    expect(r.collections).toHaveLength(1);
    const root = r.collections[0];
    expect(root.name).toBe("Acme API");
    expect(root.variables.baseUrl.value).toBe("https://api.acme.com");
    expect(root.auth).toEqual({ mode: "bearer", token: "{{token}}" });
    expect(root.preRequestScript).toBe("console.log('pre')");
  });

  it("creates a child folder collection with its request", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.children).toHaveLength(1);
    const folder = root.children[0];
    expect(folder.name).toBe("Users");
    expect(folder.requests).toHaveLength(1);
    const req = folder.requests[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe("{{baseUrl}}/users");
    expect(req.params).toEqual([
      { key: "page", value: "1", enabled: true },
      { key: "trace", value: "1", enabled: false },
    ]);
    expect(req.headers[0]).toEqual({ key: "Accept", value: "application/json", enabled: true });
  });

  it("places root-level requests on the root and maps json body + inherit auth", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.requests).toHaveLength(1);
    const req = root.requests[0];
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ mode: "json", content: '{"name":"x"}' });
    expect(req.auth).toEqual({ mode: "inherit" });
  });

  it("drops scripts when importScripts=false", () => {
    const root = p.parse(parsed, raw, { importEnvironments: true, importScripts: false }).collections[0];
    expect(root.preRequestScript).toBe("");
  });

  it("preserves '=' in string-URL query values (splits on first '=' only)", () => {
    const obj = {
      info: { name: "CB", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: "Callback",
          request: { method: "GET", url: "https://api.acme.com/cb?code=dGVzdA==&state=1" },
        },
      ],
    };
    const root = p.parse(obj, JSON.stringify(obj), opts).collections[0];
    expect(root.requests[0].params).toEqual([
      { key: "code", value: "dGVzdA==", enabled: true },
      { key: "state", value: "1", enabled: true },
    ]);
  });

  it("reports meta counts", () => {
    const m = p.parse(parsed, raw, opts).meta;
    expect(m.requestCount).toBe(2);
    expect(m.folderCount).toBe(1);
    expect(m.format).toBe("Postman Collection v2.1");
  });
});
