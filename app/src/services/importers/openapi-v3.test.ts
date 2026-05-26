import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiV3Parser } from "./openapi-v3";

const raw = readFileSync(join(__dirname, "__fixtures__/openapi-v3.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("OpenApiV3Parser", () => {
  const p = new OpenApiV3Parser();

  it("detects by openapi 3.x", () => {
    expect(p.detect(parsed, raw)).toBe(true);
    expect(p.detect({ openapi: "2.0" }, "")).toBe(false);
  });

  it("sets baseUrl variable and maps primary security to collection auth (empty secret)", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.variables.baseUrl.value).toBe("https://api.pets.com/v1");
    expect(root.auth).toEqual({ mode: "bearer", token: "" });
  });

  it("creates a child collection per tag and an operation request with inherit auth", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    const tag = root.children.find((c) => c.name === "pets")!;
    const get = tag.requests.find((r) => r.name === "Get pet")!;
    expect(get.method).toBe("GET");
    expect(get.url).toBe("{{baseUrl}}/pets/{{petId}}");
    expect(get.params).toEqual([{ key: "verbose", value: "", enabled: true }]);
    expect(get.auth).toEqual({ mode: "inherit" });
  });

  it("generates a JSON body from the schema $ref", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    const tag = root.children.find((c) => c.name === "pets")!;
    const post = tag.requests.find((r) => r.name === "Create pet")!;
    expect(post.body).toEqual({ mode: "json", content: JSON.stringify({ id: 0, name: "" }, null, 2) });
  });

  it("places untagged operations directly on the root", () => {
    const root = p.parse(parsed, raw, opts).collections[0];
    expect(root.requests.find((r) => r.name === "Health")).toBeTruthy();
  });

  it("generates JSON body for charset/+json content types", () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/things": {
          post: {
            summary: "Make thing",
            requestBody: {
              content: {
                "application/json; charset=utf-8": {
                  schema: { type: "object", properties: { a: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    };
    const root = p.parse(spec, JSON.stringify(spec), opts).collections[0];
    const req = root.requests.find((r) => r.name === "Make thing")!;
    expect(req.body).toEqual({ mode: "json", content: JSON.stringify({ a: "" }, null, 2) });
  });

  it("includes path-item-level parameters shared across methods", () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/items": {
          parameters: [{ name: "shared", in: "query", schema: { type: "string" } }],
          get: { summary: "List items" },
        },
      },
    };
    const root = p.parse(spec, JSON.stringify(spec), opts).collections[0];
    const req = root.requests.find((r) => r.name === "List items")!;
    expect(req.params).toContainEqual({ key: "shared", value: "", enabled: true });
  });

  it("resolves requestBody.$ref to a referenced request body", () => {
    const spec = {
      openapi: "3.0.0",
      components: {
        schemas: { Pet: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
        requestBodies: {
          Body: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
        },
      },
      paths: {
        "/pets": {
          post: { summary: "Create pet", requestBody: { $ref: "#/components/requestBodies/Body" } },
        },
      },
    };
    const root = p.parse(spec, JSON.stringify(spec), opts).collections[0];
    const req = root.requests.find((r) => r.name === "Create pet")!;
    expect(req.body).toEqual({ mode: "json", content: JSON.stringify({ id: 0, name: "" }, null, 2) });
  });
});
