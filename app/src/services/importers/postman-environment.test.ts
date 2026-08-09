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

		it("claims a globals export - same shape, different destination", () => {
			expect(p.detect({ _postman_variable_scope: "globals", values: [] }, "")).toBe(true);
		});

		it("claims neither scope without a values array", () => {
			expect(p.detect({ _postman_variable_scope: "globals" }, "")).toBe(false);
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
				globalCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
				unattachedFileParts: 0,
			});
		});

		it("emits nothing at all when importEnvironments is off", () => {
			const r = p.parse(parsed, raw, { importEnvironments: false, importScripts: true });
			expect(r.environments).toEqual([]);
			expect(r.collections).toEqual([]);
			expect(r.globals).toEqual({});
			expect(r.meta.environmentCount).toBe(0);
		});

		it("falls back to a name when the export has none", () => {
			const r = p.parse({ _postman_variable_scope: "environment", values: [] }, "", opts);
			expect(r.environments[0].name).toBe("Imported Environment");
			expect(r.environments[0].variables).toEqual({});
		});

		it("leaves globals empty for an environment export", () => {
			expect(p.parse(parsed, raw, opts).globals).toEqual({});
		});
	});

	describe("parse - globals scope", () => {
		const gRaw = readFileSync(join(__dirname, "__fixtures__/postman-globals.json"), "utf8");
		const gParsed = JSON.parse(gRaw);

		it("routes the variables to globals, creating no environment", () => {
			const r = p.parse(gParsed, gRaw, opts);
			expect(r.environments).toEqual([]);
			expect(r.collections).toEqual([]);
			expect(r.globals.apiHost).toEqual({ value: "https://api.example.com", enabled: true });
		});

		it("applies the same mapping rules as an environment export", () => {
			const { globals } = p.parse(gParsed, gRaw, opts);
			// secret flag from `type`, disabled entries kept as enabled:false,
			// and {{ spaced }} normalised - all inherited from toVarRecord.
			expect(globals.sharedToken).toEqual({
				value: "test-shared-token-1",
				enabled: true,
				secret: true,
			});
			expect(globals.retiredFlag.enabled).toBe(false);
			expect(globals.banner.value).toBe("welcome {{tenant}}");
		});

		it("reports the globals count and its own format name", () => {
			expect(p.parse(gParsed, gRaw, opts).meta).toEqual({
				format: "Postman Globals",
				requestCount: 0,
				folderCount: 0,
				environmentCount: 0,
				globalCount: 4,
				skipped: [],
				nonExecutableAuth: 0,
				unattachedFileParts: 0,
			});
		});

		it("drops the workspace name - the globals scope is a singleton with nowhere to put it", () => {
			const r = p.parse(gParsed, gRaw, opts);
			expect(r.environments).toHaveLength(0);
			expect(JSON.stringify(r)).not.toContain("Sample Workspace Globals");
		});

		it("emits no globals when importEnvironments is off", () => {
			const r = p.parse(gParsed, gRaw, { importEnvironments: false, importScripts: true });
			expect(r.globals).toEqual({});
			expect(r.meta.globalCount).toBe(0);
		});
	});
});
