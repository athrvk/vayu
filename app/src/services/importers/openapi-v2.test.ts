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
		const tag = p
			.parse(parsed, raw, opts)
			.collections[0].children.find((c) => c.name === "orders")!;
		const post = tag.requests.find((r) => r.name === "Place order")!;
		expect(post.body).toEqual({
			mode: "json",
			content: JSON.stringify({ id: 0, status: "" }, null, 2),
		});
	});

	it("keeps a single param row for a multi collectionFormat query", () => {
		const tag = p
			.parse(parsed, raw, opts)
			.collections[0].children.find((c) => c.name === "orders")!;
		const get = tag.requests.find((r) => r.name === "List orders")!;
		expect(get.params).toEqual([{ key: "status", value: "", enabled: true }]);
	});

	it("maps basic and oauth2 schemes via swaggerSchemeToAuth", () => {
		expect(swaggerSchemeToAuth({ type: "basic" })).toEqual({
			mode: "basic",
			username: "",
			password: "",
		});
		// The Swagger `flow` maps to a Vayu grant; client id/secret are seeded as
		// {{variables}} since a spec never carries them.
		const app = swaggerSchemeToAuth({
			type: "oauth2",
			flow: "application",
			tokenUrl: "https://idp/token",
			scopes: { read: "", write: "" },
		});
		expect(app.mode).toBe("oauth2");
		expect(
			(app as { config: { grantType: string; accessTokenUrl: string; scope: string } }).config
		).toMatchObject({
			grantType: "client_credentials",
			accessTokenUrl: "https://idp/token",
			scope: "read write",
		});
		expect((app as { config: { clientId: string } }).config.clientId).toBe("{{clientId}}");
	});

	it("resolves $ref parameters from top-level parameters", () => {
		const spec = {
			swagger: "2.0",
			info: { title: "Ref API" },
			parameters: { Status: { name: "status", in: "query", type: "string" } },
			paths: {
				"/items": {
					get: { summary: "List items", parameters: [{ $ref: "#/parameters/Status" }] },
				},
			},
		};
		const get = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "List items")!;
		expect(get.params).toContainEqual({ key: "status", value: "", enabled: true });
	});

	it("dedupes path-item params against op override (op wins)", () => {
		const spec = {
			swagger: "2.0",
			info: { title: "Dedupe API" },
			paths: {
				"/items": {
					parameters: [{ name: "q", in: "query", description: "path-level" }],
					get: {
						summary: "List items",
						parameters: [{ name: "q", in: "query", description: "op-level" }],
					},
				},
			},
		};
		const get = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "List items")!;
		expect(get.params).toEqual([
			{ key: "q", value: "", enabled: true, description: "op-level" },
		]);
	});

	const formSpec = (consumes?: string[]) => ({
		swagger: "2.0",
		info: { title: "Form API" },
		paths: {
			"/login": {
				post: {
					summary: "Log in",
					...(consumes ? { consumes } : {}),
					parameters: [
						{ name: "username", in: "formData", type: "string" },
						{ name: "password", in: "formData", type: "string" },
					],
				},
			},
		},
	});

	const formBody = (consumes?: string[]) => {
		const spec = formSpec(consumes);
		return p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "Log in")!.body;
	};

	it("maps formData to urlencoded or multipart per consumes", () => {
		expect(formBody(["application/x-www-form-urlencoded"]).mode).toBe("x-www-form-urlencoded");
		expect(formBody(["application/x-www-form-urlencoded; charset=utf-8"]).mode).toBe(
			"x-www-form-urlencoded"
		);
		expect(formBody(["multipart/form-data"]).mode).toBe("form-data");
		// Multipart wins when both are offered - it is the only one that can carry a file.
		expect(formBody(["application/x-www-form-urlencoded", "multipart/form-data"]).mode).toBe(
			"form-data"
		);
		// An absent or unrelated consumes keeps the historical multipart default.
		expect(formBody().mode).toBe("form-data");
		expect(formBody(["application/json"]).mode).toBe("form-data");
	});

	it("keeps the formData field rows whichever encoding is chosen", () => {
		const body = formBody(["application/x-www-form-urlencoded"]);
		expect(body).toEqual({
			mode: "x-www-form-urlencoded",
			fields: [
				{ key: "username", value: "", enabled: true },
				{ key: "password", value: "", enabled: true },
			],
		});
	});

	it("falls back to the spec-level consumes for the form encoding", () => {
		const spec = { ...formSpec(), consumes: ["application/x-www-form-urlencoded"] };
		const body = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "Log in")!.body;
		expect(body.mode).toBe("x-www-form-urlencoded");
	});

	it("resolves a $ref'd path item instead of dropping every operation under it", () => {
		const spec = {
			swagger: "2.0",
			info: { title: "Ref Path API" },
			paths: {
				"/users/{id}": { $ref: "#/x-pathItems/UserOps" },
				"/health": { get: { summary: "Health" } },
			},
			"x-pathItems": { UserOps: { get: { summary: "Get user" } } },
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.collections[0].requests.map((r) => r.name)).toEqual(["Get user", "Health"]);
		expect(result.meta.requestCount).toBe(2);
		expect(result.meta.skipped).toEqual([]);
	});

	it("steps over a non-array parameters block instead of aborting the file", () => {
		const spec = {
			swagger: "2.0",
			info: { title: "Malformed API" },
			paths: {
				"/items": {
					parameters: { name: "shared", in: "query" },
					get: { summary: "List items" },
				},
				"/other": { get: { summary: "Other", parameters: [{ name: "ok", in: "query" }] } },
			},
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.meta.requestCount).toBe(2);
		expect(result.collections[0].requests.find((r) => r.name === "List items")!.params).toEqual(
			[]
		);
		expect(result.collections[0].requests.find((r) => r.name === "Other")!.params).toEqual([
			{ key: "ok", value: "", enabled: true },
		]);
		expect(result.meta.skipped).toEqual([{ kind: "malformed_spec", count: 1 }]);
	});

	it("records nothing skipped for a spec it can represent whole", () => {
		expect(p.parse(parsed, raw, opts).meta.skipped).toEqual([]);
	});

	const uploadSpec = (consumes?: string[]) => ({
		swagger: "2.0",
		info: { title: "Upload API" },
		paths: {
			"/avatar": {
				post: {
					summary: "Upload avatar",
					...(consumes ? { consumes } : {}),
					parameters: [
						{ name: "caption", in: "formData", type: "string" },
						{ name: "avatar", in: "formData", type: "file" },
					],
				},
			},
		},
	});

	const uploadResult = (consumes?: string[]) => {
		const spec = uploadSpec(consumes);
		return p.parse(spec, JSON.stringify(spec), opts);
	};

	it("imports a `type: file` formData param as a file part, not an empty text row", () => {
		const result = uploadResult(["multipart/form-data"]);
		expect(result.collections[0].requests[0].body).toEqual({
			mode: "form-data",
			fields: [
				{ key: "caption", value: "", enabled: true },
				// No path: a spec documents the upload, never the file. Not `unresolved`
				// either - there is no path here that could have gone unverified.
				{ key: "avatar", value: "", enabled: true, type: "file", src: "" },
			],
		});
		expect(result.meta.unattachedFileParts).toBe(1);
	});

	it("forces multipart for a file param a urlencoded-only consumes contradicts", () => {
		// Only multipart has a file form on the wire, so the encoding follows the part.
		expect(
			uploadResult(["application/x-www-form-urlencoded"]).collections[0].requests[0].body
		).toMatchObject({ mode: "form-data" });
	});

	it("counts no unattached file part for a spec whose form is all text", () => {
		const spec = formSpec(["multipart/form-data"]);
		expect(p.parse(spec, JSON.stringify(spec), opts).meta.unattachedFileParts).toBe(0);
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
						parameters: [
							{
								name: "body",
								in: "body",
								schema: { type: "object", properties: { id: { type: "integer" } } },
							},
						],
					},
				},
			},
		};
		const post = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "Create item")!;
		expect(post.body.mode).toBe("json");
	});
});
