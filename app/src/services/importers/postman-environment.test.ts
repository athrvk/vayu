import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostmanEnvironmentParser } from "./postman-environment";

const raw = readFileSync(join(__dirname, "__fixtures__/postman-environment.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("PostmanEnvironmentParser", () => {
	const p = new PostmanEnvironmentParser();

	describe("detect", () => {
		it("claims an environment export", () => {
			expect(p.detect(parsed, raw)).toBe(true);
		});

		it("ignores a globals export - Vayu's globals scope is a separate decision", () => {
			expect(p.detect({ _postman_variable_scope: "globals", values: [] }, "")).toBe(false);
		});

		it("needs a values array, not just the scope marker", () => {
			expect(p.detect({ _postman_variable_scope: "environment" }, "")).toBe(false);
			expect(p.detect({ _postman_variable_scope: "environment", values: {} }, "")).toBe(
				false
			);
		});

		it("does not claim a collection export", () => {
			expect(p.detect({ info: { schema: "v2.1.0" }, item: [] }, "")).toBe(false);
		});

		it("survives a non-object document", () => {
			expect(p.detect(null, "")).toBe(false);
			expect(p.detect(42, "")).toBe(false);
		});
	});

	describe("parse", () => {
		it("produces one environment named after the file, and no collections", () => {
			const r = p.parse(parsed, raw, opts);
			expect(r.collections).toEqual([]);
			expect(r.environments).toHaveLength(1);
			expect(r.environments[0].name).toBe("Sample Staging");
			expect(r.environments[0].description).toBe("");
		});

		it("carries value, enabled state and the secret flag", () => {
			const vars = p.parse(parsed, raw, opts).environments[0].variables;
			expect(vars.baseUrl).toEqual({
				value: "https://staging.api.example.com",
				enabled: true,
			});
			expect(vars.apiKey).toEqual({ value: "test-api-key-1", enabled: true, secret: true });
			expect(vars.legacyHost).toEqual({ value: "old.example.com", enabled: false });
		});

		it("keeps a secret whose value Postman omitted, so the key is not lost", () => {
			const vars = p.parse(parsed, raw, opts).environments[0].variables;
			expect(vars.emptySecret).toEqual({ value: "", enabled: true, secret: true });
		});

		it("normalizes {{ spaced }} templates like every other parser", () => {
			const vars = p.parse(parsed, raw, opts).environments[0].variables;
			expect(vars.greeting.value).toBe("hello {{user.name}}");
		});

		it("drops a keyless entry", () => {
			const vars = p.parse(parsed, raw, opts).environments[0].variables;
			expect(Object.keys(vars)).toEqual([
				"baseUrl",
				"apiKey",
				"emptySecret",
				"legacyHost",
				"greeting",
			]);
		});

		it("reports counts that describe an environment-only import", () => {
			expect(p.parse(parsed, raw, opts).meta).toEqual({
				format: "Postman Environment",
				requestCount: 0,
				folderCount: 0,
				environmentCount: 1,
				skipped: [],
				nonExecutableAuth: 0,
			});
		});

		it("emits nothing at all when importEnvironments is off", () => {
			const r = p.parse(parsed, raw, { importEnvironments: false, importScripts: true });
			expect(r.environments).toEqual([]);
			expect(r.collections).toEqual([]);
			expect(r.meta.environmentCount).toBe(0);
		});

		it("falls back to a name when the export has none", () => {
			const r = p.parse({ _postman_variable_scope: "environment", values: [] }, "", opts);
			expect(r.environments[0].name).toBe("Imported Environment");
			expect(r.environments[0].variables).toEqual({});
		});
	});
});
