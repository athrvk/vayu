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
});
