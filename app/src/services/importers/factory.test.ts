import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImport } from "./factory";
import { UnrecognisedFormatError } from "./types";

const opts = { importEnvironments: true, importScripts: true };
const fx = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("parseImport", () => {
  it("routes Postman v2.1", () => {
    expect(parseImport(fx("postman-v21.json"), opts).meta.format).toBe("Postman Collection v2.1");
  });
  it("routes Postman v2.0", () => {
    expect(parseImport(fx("postman-v20.json"), opts).meta.format).toBe("Postman Collection v2.0");
  });
  it("routes Insomnia v4", () => {
    expect(parseImport(fx("insomnia-v4.json"), opts).meta.format).toBe("Insomnia Export v4");
  });
  it("routes OpenAPI 3.0", () => {
    expect(parseImport(fx("openapi-v3.json"), opts).meta.format).toBe("OpenAPI 3.0");
  });
  it("routes Swagger 2.0", () => {
    expect(parseImport(fx("swagger-v2.json"), opts).meta.format).toBe("OpenAPI 2.0 (Swagger)");
  });
  it("parses YAML input", () => {
    const yaml = "openapi: 3.0.0\ninfo:\n  title: Y\npaths: {}\n";
    expect(parseImport(yaml, opts).meta.format).toBe("OpenAPI 3.0");
  });
  it("throws on unrecognised input", () => {
    expect(() => parseImport('{"hello":"world"}', opts)).toThrow(UnrecognisedFormatError);
  });
  it("throws on malformed input", () => {
    expect(() => parseImport("not json or yaml: : :", opts)).toThrow();
  });
});
