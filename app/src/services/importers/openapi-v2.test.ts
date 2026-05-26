import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiV2Parser, swaggerSchemeToAuth } from "./openapi-v2";

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

  it("maps basic and oauth2 schemes via swaggerSchemeToAuth", () => {
    expect(swaggerSchemeToAuth({ type: "basic" })).toEqual({ mode: "basic", username: "", password: "" });
    expect(swaggerSchemeToAuth({ type: "oauth2" })).toEqual({ mode: "oauth2", config: {} });
  });

  it("resolves $ref parameters from top-level parameters", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "Ref API" },
      parameters: { Status: { name: "status", in: "query", type: "string" } },
      paths: {
        "/items": { get: { summary: "List items", parameters: [{ $ref: "#/parameters/Status" }] } },
      },
    };
    const get = p.parse(spec, JSON.stringify(spec), opts).collections[0].requests.find((r) => r.name === "List items")!;
    expect(get.params).toContainEqual({ key: "status", value: "", enabled: true });
  });

  it("dedupes path-item params against op override (op wins)", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "Dedupe API" },
      paths: {
        "/items": {
          parameters: [{ name: "q", in: "query", description: "path-level" }],
          get: { summary: "List items", parameters: [{ name: "q", in: "query", description: "op-level" }] },
        },
      },
    };
    const get = p.parse(spec, JSON.stringify(spec), opts).collections[0].requests.find((r) => r.name === "List items")!;
    expect(get.params).toEqual([{ key: "q", value: "", enabled: true, description: "op-level" }]);
  });

  it("treats charset json consume as json body", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "Charset API" },
      paths: {
        "/items": {
          post: {
            summary: "Create item",
            consumes: ["application/json; charset=utf-8"],
            parameters: [{ name: "body", in: "body", schema: { type: "object", properties: { id: { type: "integer" } } } }],
          },
        },
      },
    };
    const post = p.parse(spec, JSON.stringify(spec), opts).collections[0].requests.find((r) => r.name === "Create item")!;
    expect(post.body.mode).toBe("json");
  });
});
