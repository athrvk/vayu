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
		// Optional, and the spec declares no value for it - documentation, not intent
		// (#622), so the row imports disabled and stays off the URL.
		expect(get.params).toEqual([{ key: "verbose", value: "", enabled: false }]);
		// Same rule for the declared header (#658): optional and value-less, so the
		// row is listed but off the wire rather than sent with an empty value.
		expect(get.headers).toEqual([{ key: "X-Request-Id", value: "", enabled: false }]);
		expect(get.auth).toEqual({ mode: "inherit" });
	});

	it("generates a JSON body from the schema $ref", () => {
		const root = p.parse(parsed, raw, opts).collections[0];
		const tag = root.children.find((c) => c.name === "pets")!;
		const post = tag.requests.find((r) => r.name === "Create pet")!;
		expect(post.body).toEqual({
			mode: "json",
			content: JSON.stringify({ id: 0, name: "" }, null, 2),
		});
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
									schema: {
										type: "object",
										properties: { a: { type: "string" } },
									},
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
		expect(req.params).toContainEqual({ key: "shared", value: "", enabled: false });
	});

	it("records nothing skipped for a spec it can represent whole", () => {
		expect(p.parse(parsed, raw, opts).meta.skipped).toEqual([]);
	});

	it("resolves a $ref'd path item instead of dropping every operation under it", () => {
		const spec = {
			openapi: "3.1.0",
			components: {
				pathItems: {
					UserOps: {
						parameters: [{ name: "expand", in: "query", schema: { type: "string" } }],
						get: { summary: "Get user" },
						delete: { summary: "Delete user" },
					},
				},
			},
			paths: { "/users/{id}": { $ref: "#/components/pathItems/UserOps" } },
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		const names = result.collections[0].requests.map((r) => r.name);
		expect(names).toEqual(["Get user", "Delete user"]);
		expect(result.meta.requestCount).toBe(2);
		// The referenced item's shared parameters come along with it.
		const get = result.collections[0].requests[0];
		expect(get.params).toEqual([{ key: "expand", value: "", enabled: false }]);
		expect(get.url).toBe("{{baseUrl}}/users/{{id}}");
		expect(result.meta.skipped).toEqual([]);
	});

	it("records a path item whose $ref does not resolve, rather than dropping it silently", () => {
		const spec = {
			openapi: "3.1.0",
			paths: {
				"/gone": { $ref: "#/components/pathItems/Missing" },
				"/here": { get: { summary: "Here" } },
			},
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.meta.requestCount).toBe(1);
		expect(result.meta.skipped).toEqual([{ kind: "malformed_spec", count: 1 }]);
	});

	it("resolves a $ref'd form-body schema to its fields", () => {
		const spec = {
			openapi: "3.0.0",
			components: {
				schemas: {
					TokenRequest: {
						type: "object",
						properties: {
							grant_type: { type: "string" },
							username: { type: "string" },
							password: { type: "string" },
						},
					},
				},
			},
			paths: {
				"/token": {
					post: {
						summary: "Get token",
						requestBody: {
							content: {
								"application/x-www-form-urlencoded": {
									schema: { $ref: "#/components/schemas/TokenRequest" },
								},
							},
						},
					},
				},
			},
		};
		const req = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "Get token")!;
		expect(req.body).toEqual({
			mode: "x-www-form-urlencoded",
			fields: [
				{ key: "grant_type", value: "", enabled: true },
				{ key: "username", value: "", enabled: true },
				{ key: "password", value: "", enabled: true },
			],
		});
	});

	it("resolves an allOf multipart form-body schema to its fields", () => {
		const spec = {
			openapi: "3.0.0",
			components: {
				schemas: { Upload: { type: "object", properties: { file: { type: "string" } } } },
			},
			paths: {
				"/upload": {
					post: {
						summary: "Upload",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: { allOf: [{ $ref: "#/components/schemas/Upload" }] },
								},
							},
						},
					},
				},
			},
		};
		const req = p
			.parse(spec, JSON.stringify(spec), opts)
			.collections[0].requests.find((r) => r.name === "Upload")!;
		expect(req.body).toEqual({
			mode: "form-data",
			fields: [{ key: "file", value: "", enabled: true }],
		});
	});

	const uploadSpec = (contentType: string) => ({
		openapi: "3.0.0",
		paths: {
			"/avatar": {
				post: {
					summary: "Upload avatar",
					requestBody: {
						content: {
							[contentType]: {
								schema: {
									type: "object",
									properties: {
										caption: { type: "string" },
										avatar: { type: "string", format: "binary" },
									},
								},
							},
						},
					},
				},
			},
		},
	});

	it("imports a `format: binary` multipart property as a file part, not an empty text row", () => {
		const spec = uploadSpec("multipart/form-data");
		const result = p.parse(spec, JSON.stringify(spec), opts);
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

	it("leaves a binary property under urlencoded as text - that wire form has no file", () => {
		const spec = uploadSpec("application/x-www-form-urlencoded");
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.collections[0].requests[0].body).toEqual({
			mode: "x-www-form-urlencoded",
			fields: [
				{ key: "caption", value: "", enabled: true },
				{ key: "avatar", value: "", enabled: true },
			],
		});
		expect(result.meta.unattachedFileParts).toBe(0);
	});

	it("counts unattached file parts across tagged and untagged operations", () => {
		const upload = uploadSpec("multipart/form-data").paths["/avatar"].post;
		const spec = {
			openapi: "3.0.0",
			paths: {
				"/avatar": { post: upload },
				"/docs": { post: { ...upload, summary: "Upload doc", tags: ["docs"] } },
			},
		};
		expect(p.parse(spec, JSON.stringify(spec), opts).meta.unattachedFileParts).toBe(2);
	});

	it("records a TRACE operation as an unsupported method instead of omitting it", () => {
		const spec = {
			openapi: "3.0.0",
			paths: {
				"/debug": {
					trace: { summary: "Trace it" },
					get: { summary: "Get it" },
				},
			},
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.meta.requestCount).toBe(1); // TRACE cannot be built; the count stays honest
		expect(result.collections[0].requests.map((r) => r.name)).toEqual(["Get it"]);
		expect(result.meta.skipped).toEqual([{ kind: "unsupported_method", count: 1 }]);
	});

	it("steps over a non-array parameters block instead of aborting the file", () => {
		const spec = {
			openapi: "3.0.0",
			paths: {
				// The classic hand-edited-YAML mistake: a missing `-` makes this a mapping.
				"/items": {
					parameters: { name: "shared", in: "query" },
					get: { summary: "List items", parameters: { name: "q", in: "query" } },
				},
				"/other": {
					get: {
						summary: "Other",
						parameters: [{ name: "ok", in: "query" }],
					},
				},
			},
		};
		const result = p.parse(spec, JSON.stringify(spec), opts);
		expect(result.meta.requestCount).toBe(2);
		const list = result.collections[0].requests.find((r) => r.name === "List items")!;
		expect(list.params).toEqual([]);
		// Every other path still imports, params and all.
		const other = result.collections[0].requests.find((r) => r.name === "Other")!;
		expect(other.params).toEqual([{ key: "ok", value: "", enabled: false }]);
		expect(result.meta.skipped).toEqual([{ kind: "malformed_spec", count: 2 }]);
	});

	describe("a spec whose responses live in components (issue #714)", () => {
		// GitHub's shape. Both indexes stored beside the document are built in
		// this one walk, so this is where they can be held to the same answer.
		const spec = {
			openapi: "3.0.0",
			paths: {
				"/repos/{owner}/{repo}": {
					get: {
						operationId: "repos/get",
						summary: "Get a repository",
						responses: {
							"200": {
								description: "ok",
								content: {
									"application/json": {
										schema: { $ref: "#/components/schemas/repo" },
									},
								},
							},
							"404": { $ref: "#/components/responses/not_found" },
						},
					},
				},
			},
			components: {
				responses: {
					not_found: {
						description: "Resource not found",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/basic_error" },
							},
						},
					},
				},
				schemas: { repo: { type: "object" }, basic_error: { type: "object" } },
			},
		};

		it("agrees with coverage about which statuses are declared", () => {
			// Coverage reads the status *keys* and so always saw the 404;
			// extraction read the `$ref` node's absent `content` and saw nothing,
			// so the two contradicted each other about one document on one run.
			// Revert the deref and the 404 vanishes from the schema index while
			// staying in the operation index.
			const root = p.parse(spec, JSON.stringify(spec), opts).collections[0];
			const declared = root.spec!.operations!.find(
				(o) => o.path === "/repos/{owner}/{repo}"
			)!;
			expect(declared.responses).toEqual(["200", "404"]);

			const indexed = root.spec!.responseSchemas!.operations.find(
				(o) => o.path === "/repos/{owner}/{repo}"
			)!;
			expect(indexed.responses.map((r) => r.status)).toEqual(["200", "404"]);
			expect(indexed.responses.find((r) => r.status === "404")).toEqual({
				status: "404",
				contentType: "application/json",
				schema: { $ref: "#/components/schemas/basic_error" },
			});
			// The schema the `$ref`'d response points at has to be reachable, or
			// the entry validates nothing - `refRoots` is where the engine looks.
			expect(root.spec!.responseSchemas!.refRoots).toEqual({
				components: {
					schemas: { repo: { type: "object" }, basic_error: { type: "object" } },
				},
			});
		});

		it("counts a response `$ref` that resolves to nothing exactly once", () => {
			// Two readers deref this entry - examples and schema extraction - and
			// only the examples walk tallies. Counting in both would report one
			// broken ref as two lost items in the import preview.
			const broken = {
				...spec,
				paths: {
					"/repos/{owner}/{repo}": {
						get: {
							operationId: "repos/get",
							summary: "Get a repository",
							responses: { "404": { $ref: "#/components/responses/gone_missing" } },
						},
					},
				},
			};
			const result = p.parse(broken, JSON.stringify(broken), opts);
			expect(result.meta.skipped).toEqual([{ kind: "malformed_spec", count: 1 }]);
			// And nothing half-extracted lands in the index.
			expect(result.collections[0].spec!.responseSchemas).toBeUndefined();
		});
	});

	it("resolves requestBody.$ref to a referenced request body", () => {
		const spec = {
			openapi: "3.0.0",
			components: {
				schemas: {
					Pet: {
						type: "object",
						properties: { id: { type: "integer" }, name: { type: "string" } },
					},
				},
				requestBodies: {
					Body: {
						content: {
							"application/json": { schema: { $ref: "#/components/schemas/Pet" } },
						},
					},
				},
			},
			paths: {
				"/pets": {
					post: {
						summary: "Create pet",
						requestBody: { $ref: "#/components/requestBodies/Body" },
					},
				},
			},
		};
		const root = p.parse(spec, JSON.stringify(spec), opts).collections[0];
		const req = root.requests.find((r) => r.name === "Create pet")!;
		expect(req.body).toEqual({
			mode: "json",
			content: JSON.stringify({ id: 0, name: "" }, null, 2),
		});
	});

	/**
	 * Issue #622. A declared parameter is documentation until the spec says
	 * otherwise, and since #590 every enabled row joins the stored `url` - so the
	 * enabled flag decides what an imported request sends.
	 */
	describe("query parameter enabled state", () => {
		const paramsOf = (parameters: unknown[]) => {
			const spec = {
				openapi: "3.0.0",
				info: { title: "Params API" },
				components: { schemas: { Limit: { type: "integer", default: 25 } } },
				paths: { "/items": { get: { summary: "List items", parameters } } },
			};
			return p.parse(spec, JSON.stringify(spec), opts).collections[0].requests[0].params;
		};

		it("imports an optional value-less parameter disabled and a required one enabled", () => {
			expect(
				paramsOf([
					{ name: "verbose", in: "query", schema: { type: "boolean" } },
					{ name: "tenant", in: "query", required: true, schema: { type: "string" } },
				])
			).toEqual([
				{ key: "verbose", value: "", enabled: false },
				{ key: "tenant", value: "", enabled: true },
			]);
		});

		it("carries a schema default as the row's value, enabled", () => {
			expect(
				paramsOf([{ name: "limit", in: "query", schema: { type: "integer", default: 25 } }])
			).toEqual([{ key: "limit", value: "25", enabled: true }]);
		});

		it("prefers the parameter's example over the schema's default", () => {
			expect(
				paramsOf([
					{
						name: "status",
						in: "query",
						example: "available",
						schema: { type: "string", default: "pending" },
					},
				])
			).toEqual([{ key: "status", value: "available", enabled: true }]);
		});

		it("unwraps the first entry of an examples map", () => {
			expect(
				paramsOf([
					{
						name: "sort",
						in: "query",
						examples: { byName: { value: "name" }, byAge: { value: "age" } },
					},
				])
			).toEqual([{ key: "sort", value: "name", enabled: true }]);
		});

		it("reads a default through a $ref'd schema", () => {
			expect(
				paramsOf([
					{ name: "limit", in: "query", schema: { $ref: "#/components/schemas/Limit" } },
				])
			).toEqual([{ key: "limit", value: "25", enabled: true }]);
		});

		it("leaves a non-scalar default value-less, since one row cannot express its serialization", () => {
			// `style`/`explode` decide how an array reaches the wire and this importer
			// reads neither - a joined guess would send what the spec did not declare.
			expect(
				paramsOf([
					{ name: "tags", in: "query", schema: { type: "array", default: ["a", "b"] } },
					{ name: "filter", in: "query", schema: { type: "object", default: { a: 1 } } },
				])
			).toEqual([
				{ key: "tags", value: "", enabled: false },
				{ key: "filter", value: "", enabled: false },
			]);
		});

		it("treats a declared empty-string default as no value at all", () => {
			// A row with an empty value writes as a bare key, so `?q=` is not a shape
			// the Params table can hold - the row would send `?q`, which is not what
			// `default: ""` says.
			expect(
				paramsOf([{ name: "q", in: "query", schema: { type: "string", default: "" } }])
			).toEqual([{ key: "q", value: "", enabled: false }]);
		});

		it("keeps the description on a disabled row", () => {
			expect(
				paramsOf([{ name: "verbose", in: "query", description: "Expand the payload" }])
			).toEqual([
				{ key: "verbose", value: "", enabled: false, description: "Expand the payload" },
			]);
		});
	});

	/**
	 * Issue #658, the header half of the same rule. An enabled header row with an
	 * empty value is a header nobody chose: the request claims to send
	 * `X-Request-Id` with nothing in it, which is more likely to trip server
	 * validation than an absent query key is.
	 */
	describe("header parameter enabled state", () => {
		const headersOf = (parameters: unknown[]) => {
			const spec = {
				openapi: "3.0.0",
				info: { title: "Header API" },
				components: { schemas: { Tenant: { type: "string", default: "acme" } } },
				paths: { "/items": { get: { summary: "List items", parameters } } },
			};
			return p.parse(spec, JSON.stringify(spec), opts).collections[0].requests[0].headers;
		};

		it("imports an optional value-less header disabled and a required one enabled", () => {
			expect(
				headersOf([
					{ name: "X-Request-Id", in: "header", schema: { type: "string" } },
					{
						name: "X-Tenant",
						in: "header",
						required: true,
						schema: { type: "string" },
					},
				])
			).toEqual([
				{ key: "X-Request-Id", value: "", enabled: false },
				{ key: "X-Tenant", value: "", enabled: true },
			]);
		});

		it("carries a declared value, by the same precedence a query row uses", () => {
			expect(
				headersOf([
					{
						name: "X-Api-Version",
						in: "header",
						example: "2026-08-01",
						schema: { type: "string", default: "2024-01-01" },
					},
					{
						name: "X-Tenant",
						in: "header",
						schema: { $ref: "#/components/schemas/Tenant" },
					},
				])
			).toEqual([
				{ key: "X-Api-Version", value: "2026-08-01", enabled: true },
				{ key: "X-Tenant", value: "acme", enabled: true },
			]);
		});

		it("leaves a non-scalar declared value value-less and disabled", () => {
			expect(
				headersOf([
					{ name: "X-Tags", in: "header", schema: { type: "array", default: ["a"] } },
				])
			).toEqual([{ key: "X-Tags", value: "", enabled: false }]);
		});

		it("carries no description, since the Headers table has no column for one", () => {
			expect(
				headersOf([{ name: "X-Request-Id", in: "header", description: "Correlation id" }])
			).toEqual([{ key: "X-Request-Id", value: "", enabled: false }]);
		});

		it("still drops the headers Vayu manages, required or not", () => {
			expect(
				headersOf([
					{ name: "Authorization", in: "header", required: true },
					{ name: "content-type", in: "header", example: "application/json" },
					{ name: "X-Keep", in: "header", required: true },
				])
			).toEqual([{ key: "X-Keep", value: "", enabled: true }]);
		});
	});
});
