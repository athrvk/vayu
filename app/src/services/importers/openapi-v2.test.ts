import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiV2Parser } from "./openapi-v2";

const raw = readFileSync(join(__dirname, "__fixtures__/swagger-v2.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("OpenApiV2Parser", () => {
  const p = new OpenApiV2Parser();

  it("detects by swagger 2.0", () => {
    expect(p.detect(parsed, raw)).toBe(true);
    expect(p.detect({ openapi: "3.0.0" }, "")).toBe(false);
  });

  it("constructs baseUrl from scheme+host+basePath and maps apiKey scheme", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.variables.baseUrl.value).toBe("https://api.store.com/v2");
    expect(root.auth).toEqual({ mode: "apikey", key: "X-API-Key", value: "", in: "header" });
  });

  it("builds JSON body from the in:body param schema", () => {
    const tag = p.parse(parsed, raw, opts).collections[0].children.find((c) => c.name === "orders")!;
    const post = tag.requests.find((r) => r.name === "Place order")!;
    expect(post.body).toEqual({ mode: "json", content: JSON.stringify({ id: 0, status: "" }, null, 2) });
  });

  it("keeps a single param row for a multi collectionFormat query", () => {
    const tag = p.parse(parsed, raw, opts).collections[0].children.find((c) => c.name === "orders")!;
    const get = tag.requests.find((r) => r.name === "List orders")!;
    expect(get.params).toEqual([{ key: "status", value: "", enabled: true }]);
  });
});
