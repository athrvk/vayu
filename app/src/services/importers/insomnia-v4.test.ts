import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InsomniaV4Parser } from "./insomnia-v4";

const raw = readFileSync(join(__dirname, "__fixtures__/insomnia-v4.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("InsomniaV4Parser", () => {
  const p = new InsomniaV4Parser();

  it("detects by _type+__export_format", () => {
    expect(p.detect(parsed, raw)).toBe(true);
    expect(p.detect({ _type: "export", __export_format: 3 }, "")).toBe(false);
  });

  it("builds workspace root with a request_group child", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.name).toBe("Acme");
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe("Users");
    expect(root.children[0].auth).toEqual({ mode: "bearer", token: "{{token}}" });
  });

  it("normalizes {{ _.x }} vars in request url/params and maps json body", () => {
    const folder = p.parse(parsed, raw, opts).collections[0].children[0];
    const req = folder.requests[0];
    expect(req.url).toBe("{{baseUrl}}/users");
    expect(req.params).toEqual([
      { key: "page", value: "1", enabled: true },
      { key: "trace", value: "1", enabled: false },
    ]);
    expect(req.body).toEqual({ mode: "json", content: '{"a":1}' });
  });

  it("places workspace-level request on root and defaults missing auth to inherit", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.requests).toHaveLength(1);
    expect(root.requests[0].name).toBe("Ping");
    expect(root.requests[0].auth).toEqual({ mode: "inherit" });
  });

  it("drops grpc/websocket resources and counts them in meta.skipped", () => {
    const meta = p.parse(parsed, raw, opts).meta;
    expect(meta.skipped.find((s) => s.kind === "grpc")?.count).toBe(1);
  });

  it("flattens sub-environments with base merged, sub winning, values stringified", () => {
    const envs = p.parse(parsed, raw, opts).environments;
    const prod = envs.find((e) => e.name === "Production")!;
    expect(prod.variables.baseUrl.value).toBe("https://prod.acme.com");
    expect(prod.variables.timeout.value).toBe("30");
  });

  it("handles charset-suffixed json mimeType", () => {
    const doc = {
      _type: "export", __export_format: 4,
      resources: [
        { _id: "w", _type: "workspace", name: "W" },
        { _id: "r", _type: "request", parentId: "w", name: "R", method: "post",
          url: "https://x/y", body: { mimeType: "application/json; charset=utf-8", text: "{\"a\":1}" } },
      ],
    };
    const req = p.parse(doc, JSON.stringify(doc), opts).collections[0].requests[0];
    expect(req.body).toEqual({ mode: "json", content: '{"a":1}' });
  });

  it("disabled auth → none; collection inherit → none", () => {
    const doc = {
      _type: "export", __export_format: 4,
      resources: [
        { _id: "w", _type: "workspace", name: "W" },
        { _id: "r", _type: "request", parentId: "w", name: "R", method: "get", url: "https://x",
          authentication: { type: "bearer", token: "T", disabled: true } },
      ],
    };
    const result = p.parse(doc, JSON.stringify(doc), opts);
    expect(result.collections[0].requests[0].auth).toEqual({ mode: "none" });
    expect(result.collections[0].auth).toEqual({ mode: "none" }); // workspace had no auth → inherit → none
  });

  it("base environment with no sub-envs becomes one Environment named after the base", () => {
    const doc = {
      _type: "export", __export_format: 4,
      resources: [
        { _id: "w", _type: "workspace", name: "W" },
        { _id: "e", _type: "environment", parentId: "w", name: "Base", data: { k: 1 } },
      ],
    };
    const envs = p.parse(doc, JSON.stringify(doc), opts).environments;
    expect(envs).toHaveLength(1);
    expect(envs[0].name).toBe("Base");
    expect(envs[0].variables.k.value).toBe("1");
  });
});
