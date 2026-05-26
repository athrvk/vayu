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
});
