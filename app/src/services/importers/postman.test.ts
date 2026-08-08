import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostmanV21Parser, PostmanV20Parser } from "./postman";

const raw = readFileSync(join(__dirname, "__fixtures__/postman-v21.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

describe("PostmanV21Parser", () => {
	const p = new PostmanV21Parser();

	it("detects v2.1 by schema", () => {
		expect(p.detect(parsed, raw)).toBe(true);
		expect(p.detect({ info: { schema: "v2.0.0" } }, "")).toBe(false);
	});

	it("builds a root collection with name, vars, auth, script", () => {
		const r = p.parse(parsed, raw, opts);
		expect(r.collections).toHaveLength(1);
		const root = r.collections[0];
		expect(root.name).toBe("Sample API");
		expect(root.variables.baseUrl.value).toBe("https://api.example.com");
		expect(root.auth).toEqual({ mode: "bearer", token: "{{token}}" });
		expect(root.preRequestScript).toBe("console.log('pre')");
	});

	it("creates a child folder collection with its request", () => {
		const root = p.parse(parsed, raw, opts).collections[0];
		expect(root.children).toHaveLength(1);
		const folder = root.children[0];
		expect(folder.name).toBe("Users");
		expect(folder.requests).toHaveLength(1);
		const req = folder.requests[0];
		expect(req.method).toBe("GET");
		expect(req.url).toBe("{{baseUrl}}/users");
		expect(req.params).toEqual([
			{ key: "page", value: "1", enabled: true },
			{ key: "trace", value: "1", enabled: false },
		]);
		expect(req.headers[0]).toEqual({ key: "Accept", value: "application/json", enabled: true });
	});

	it("places root-level requests on the root and maps json body + inherit auth", () => {
		const root = p.parse(parsed, raw, opts).collections[0];
		expect(root.requests).toHaveLength(1);
		const req = root.requests[0];
		expect(req.method).toBe("POST");
		expect(req.body).toEqual({ mode: "json", content: '{"name":"x"}' });
		expect(req.auth).toEqual({ mode: "inherit" });
	});

	it("drops scripts when importScripts=false", () => {
		const root = p.parse(parsed, raw, { importEnvironments: true, importScripts: false })
			.collections[0];
		expect(root.preRequestScript).toBe("");
	});

	it("preserves '=' in string-URL query values (splits on first '=' only)", () => {
		const obj = {
			info: {
				name: "CB",
				schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
			},
			item: [
				{
					name: "Callback",
					request: {
						method: "GET",
						url: "https://api.example.com/cb?code=dGVzdA==&state=1",
					},
				},
			],
		};
		const root = p.parse(obj, JSON.stringify(obj), opts).collections[0];
		expect(root.requests[0].params).toEqual([
			{ key: "code", value: "dGVzdA==", enabled: true },
			{ key: "state", value: "1", enabled: true },
		]);
	});

	/**
	 * One fixture-shaped collection per finding in issue #195. Each is built inline
	 * rather than added to the shared fixture, so a case that regresses names the
	 * defect it came from instead of shifting counts in the fixture-wide tests.
	 */
	function collectionOf(items: unknown[], extra: Record<string, unknown> = {}) {
		return {
			info: {
				name: "CB",
				schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
			},
			item: items,
			...extra,
		};
	}
	const parse = (obj: unknown) => p.parse(obj, JSON.stringify(obj), opts);

	it("imports awsv4 auth as the aws mode with its config, and counts it", () => {
		// The wire type is `awsv4`; matching on `"aws"` sent every real SigV4 export
		// to the `default` branch, which discarded the keys AND suppressed the
		// warning counter, so the preview reported a clean import.
		const result = parse(
			collectionOf([
				{
					name: "Signed",
					request: {
						method: "GET",
						url: "https://api.example.com/x",
						auth: {
							type: "awsv4",
							awsv4: [
								{ key: "accessKey", value: "AKIA" },
								{ key: "secretKey", value: "s3cret" },
								{ key: "region", value: "us-east-1" },
								{ key: "service", value: "execute-api" },
							],
						},
					},
				},
			])
		);

		expect(result.collections[0].requests[0].auth).toEqual({
			mode: "aws",
			config: {
				accessKey: "AKIA",
				secretKey: "s3cret",
				region: "us-east-1",
				service: "execute-api",
			},
		});
		expect(result.meta.nonExecutableAuth).toBe(1);
	});

	it("keeps an explicit folder noauth terminal, and an absent one transparent", () => {
		// Postman's No Auth on a folder stops inheritance; a folder that simply has
		// no auth field does not. Both used to become `{mode:"none"}`, which the
		// resolution walk steps over - so the folder's requests silently regained
		// the root's bearer token.
		const root = parse(
			collectionOf(
				[
					{
						name: "Public endpoints",
						auth: { type: "noauth" },
						item: [
							{
								name: "Health",
								request: { method: "GET", url: "https://x/health" },
							},
						],
					},
					{ name: "Private", item: [] },
				],
				{ auth: { type: "bearer", bearer: [{ key: "token", value: "T" }] } }
			)
		).collections[0];

		expect(root.children[0].auth).toEqual({ mode: "noauth" });
		expect(root.children[1].auth).toEqual({ mode: "none" });
	});

	it("parses GraphQL variables into an object, keeping unparseable text", () => {
		const [ok, bad, empty] = parse(
			collectionOf(
				[
					{ query: "{ me }", variables: '{"limit": 10}' },
					{ query: "{ me }", variables: "{limit: 10" },
					{ query: "{ me }", variables: "  " },
				].map((graphql, i) => ({
					name: `gql${i}`,
					request: {
						method: "POST",
						url: "https://x/graphql",
						body: { mode: "graphql", graphql },
					},
				}))
			)
		).collections[0].requests;

		expect(JSON.parse((ok.body as { content: string }).content)).toEqual({
			query: "{ me }",
			variables: { limit: 10 },
		});
		expect(JSON.parse((bad.body as { content: string }).content)).toEqual({
			query: "{ me }",
			variables: "{limit: 10",
		});
		expect(JSON.parse((empty.body as { content: string }).content)).toEqual({
			query: "{ me }",
		});
	});

	it("preserves operationName on a multi-operation import", () => {
		// Postman stores it and Vayu's panes now carry it. Without both halves the
		// request executes whichever operation the server picks.
		const [req] = parse(
			collectionOf([
				{
					name: "gql",
					request: {
						method: "POST",
						url: "https://x/graphql",
						body: {
							mode: "graphql",
							graphql: {
								query: "query A { a } query B { b }",
								operationName: "B",
							},
						},
					},
				},
			])
		).collections[0].requests;

		expect(JSON.parse((req.body as { content: string }).content)).toEqual({
			query: "query A { a } query B { b }",
			operationName: "B",
		});
	});

	describe("GraphQL Content-Type", () => {
		const gqlRequest = (headers: unknown[] = []) => ({
			name: "gql",
			request: {
				method: "POST",
				url: "https://x/graphql",
				header: headers,
				body: { mode: "graphql", graphql: { query: "{ me }" } },
			},
		});

		// Without this the request goes out as libcurl's default
		// `application/x-www-form-urlencoded`, which most GraphQL servers 400 -
		// and it looks identical to a working request in every pane.
		it("is added at import", () => {
			const [req] = parse(collectionOf([gqlRequest()])).collections[0].requests;
			expect(req.headers).toEqual([
				{ key: "Content-Type", value: "application/json", enabled: true },
			]);
		});

		it("does not replace one the collection already declares", () => {
			const [req] = parse(
				collectionOf([gqlRequest([{ key: "content-type", value: "application/graphql" }])])
			).collections[0].requests;
			expect(req.headers).toEqual([
				{ key: "content-type", value: "application/graphql", enabled: true },
			]);
		});

		// A disabled row is not sent, so it does not count as declaring one.
		it("is added when the declared row is disabled", () => {
			const [req] = parse(
				collectionOf([
					gqlRequest([
						{ key: "Content-Type", value: "application/graphql", disabled: true },
					]),
				])
			).collections[0].requests;
			expect(req.headers).toContainEqual({
				key: "Content-Type",
				value: "application/json",
				enabled: true,
			});
		});

		it("is not added to a body that needs no header of its own", () => {
			const [req] = parse(
				collectionOf([
					{
						name: "json",
						request: {
							method: "POST",
							url: "https://x/y",
							body: { mode: "raw", raw: "{}" },
						},
					},
				])
			).collections[0].requests;
			expect(req.headers).toEqual([]);
		});
	});

	it("reads item-level protocolProfileBehavior into the redirect settings", () => {
		// Postman writes this block exactly where the user overrode redirect
		// handling. The engine's default is follow=true, so dropping a `false` here
		// follows the 3xx the request exists to inspect.
		const [overridden, plain] = parse(
			collectionOf([
				{
					name: "Login",
					protocolProfileBehavior: { followRedirects: false, maxRedirects: 3 },
					request: { method: "POST", url: "https://x/login" },
				},
				{ name: "Plain", request: { method: "GET", url: "https://x/y" } },
			])
		).collections[0].requests;

		expect(overridden.followRedirects).toBe(false);
		expect(overridden.maxRedirects).toBe(3);
		// Absent, not defaulted: the engine seeds its own defaults for a request
		// whose source said nothing.
		expect(plain.followRedirects).toBeUndefined();
		expect(plain.maxRedirects).toBeUndefined();
	});

	it("ignores a protocolProfileBehavior whose values are the wrong type", () => {
		const req = parse(
			collectionOf([
				{
					name: "Odd",
					protocolProfileBehavior: { followRedirects: "false", maxRedirects: "3" },
					request: { method: "GET", url: "https://x/y" },
				},
			])
		).collections[0].requests[0];

		// A coerced "false" would read as the user's setting while being its opposite.
		expect(req.followRedirects).toBeUndefined();
		expect(req.maxRedirects).toBeUndefined();
	});

	it("survives a malformed percent-sequence in a string URL query", () => {
		const req = parse(
			collectionOf([
				{
					name: "Discount",
					request: { method: "GET", url: "https://x/search?discount=50%&q=a%zzb" },
				},
			])
		).collections[0].requests[0];

		// One bad character used to throw URIError out of parseImport and fail the
		// whole file with no pointer to the offending request.
		expect(req.params).toEqual([
			{ key: "discount", value: "50%", enabled: true },
			{ key: "q", value: "a%zzb", enabled: true },
		]);
	});

	it("falls back to raw's query when an object URL has no query[]", () => {
		const req = parse(
			collectionOf([
				{
					name: "Raw only",
					request: {
						method: "GET",
						url: { raw: "https://x/y?page=2&apiKey=abc" },
					},
				},
			])
		).collections[0].requests[0];

		expect(req.url).toBe("https://x/y");
		expect(req.params).toEqual([
			{ key: "page", value: "2", enabled: true },
			{ key: "apiKey", value: "abc", enabled: true },
		]);
	});

	it("still prefers query[] over raw when both are present", () => {
		// `query[]` carries disabled state and descriptions that `raw` cannot.
		const req = parse(
			collectionOf([
				{
					name: "Both",
					request: {
						method: "GET",
						url: {
							raw: "https://x/y?page=99",
							query: [{ key: "page", value: "2", disabled: true }],
						},
					},
				},
			])
		).collections[0].requests[0];

		expect(req.params).toEqual([{ key: "page", value: "2", enabled: false }]);
	});

	/**
	 * An imported form body has to arrive in the shape the *engine* reads:
	 * `deserialize_request` matches these mode strings exactly and takes the
	 * content out of `fields` (issue #381). A Postman `formdata` item that
	 * mapped to any other spelling, or to a `content` string, would import
	 * cleanly, display correctly, and send an empty body.
	 */
	it("maps both form body modes to the engine's fields shape", () => {
		const requests = parse(
			collectionOf([
				{
					name: "Urlencoded",
					request: {
						method: "POST",
						url: "https://x/form",
						body: {
							mode: "urlencoded",
							urlencoded: [
								{ key: "a", value: "1" },
								{ key: "b", value: "2", disabled: true },
							],
						},
					},
				},
				{
					name: "Multipart",
					request: {
						method: "POST",
						url: "https://x/multipart",
						body: {
							mode: "formdata",
							formdata: [
								{ key: "note", value: "hi", type: "text" },
								{ key: "avatar", src: "/tmp/a.png", type: "file" },
							],
						},
					},
				},
			])
		).collections[0].requests;

		expect(requests[0].body).toEqual({
			mode: "x-www-form-urlencoded",
			fields: [
				{ key: "a", value: "1", enabled: true },
				{ key: "b", value: "2", enabled: false },
			],
		});
		// File parts have no engine-side representation yet, so they are counted
		// as skipped rather than imported as empty text fields.
		expect(requests[1].body).toEqual({
			mode: "form-data",
			fields: [{ key: "note", value: "hi", enabled: true }],
		});
	});

	it("leaves a literal single-brace value alone", () => {
		// `{beta}` is a valid literal path segment in Postman, where only `{{x}}` is
		// template syntax. Rewriting it invented a variable that resolves to nothing.
		const req = parse(
			collectionOf([
				{
					name: "Literal",
					request: {
						method: "GET",
						url: "https://x/tags/{beta}?fields=friends{name}",
						header: [{ key: "X-Shape", value: "{id}" }],
					},
				},
			])
		).collections[0].requests[0];

		expect(req.url).toBe("https://x/tags/{beta}");
		expect(req.params).toEqual([{ key: "fields", value: "friends{name}", enabled: true }]);
		expect(req.headers[0].value).toBe("{id}");
	});

	it("skips a non-object item or event instead of throwing", () => {
		const result = parse(
			collectionOf([
				null,
				"nonsense",
				{
					name: "Real",
					event: [null, { listen: "test", script: { exec: ["ok"] } }],
					request: { method: "GET", url: "https://x/y" },
				},
				{
					name: "Folder",
					item: [null, { name: "Deep", request: { method: "GET", url: "https://x/z" } }],
				},
			])
		);

		const root = result.collections[0];
		expect(root.requests.map((r) => r.name)).toEqual(["Real"]);
		expect(root.requests[0].postRequestScript).toBe("ok");
		expect(root.children[0].requests.map((r) => r.name)).toEqual(["Deep"]);
		// Visible in the preview rather than merely non-fatal: two at the root, one
		// inside the folder.
		expect(result.meta.skipped).toEqual([{ kind: "malformed_item", count: 3 }]);
	});

	it("reports meta counts", () => {
		const m = p.parse(parsed, raw, opts).meta;
		expect(m.requestCount).toBe(2);
		expect(m.folderCount).toBe(1);
		expect(m.format).toBe("Postman Collection v2.1");
	});
});

describe("PostmanV20Parser", () => {
	const raw20 = readFileSync(join(__dirname, "__fixtures__/postman-v20.json"), "utf8");
	const parsed20 = JSON.parse(raw20);
	const p = new PostmanV20Parser();
	const opts = { importEnvironments: true, importScripts: true };

	it("detects v2.0 by schema and by info+item without schema", () => {
		expect(p.detect(parsed20, raw20)).toBe(true);
		expect(p.detect({ info: { name: "x" }, item: [] }, "")).toBe(true);
		expect(p.detect({ info: { schema: "v2.1.0" } }, "")).toBe(false);
	});

	it("parses string URL with query and v2.0 object-shape bearer auth", () => {
		const req = p.parse(parsed20, raw20, opts).collections[0].requests[0];
		expect(req.url).toBe("https://legacy.example.com/things");
		expect(req.params).toEqual([{ key: "id", value: "5", enabled: true }]);
		expect(req.auth).toEqual({ mode: "bearer", token: "LEGACY" });
	});
});
