import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InsomniaV4Parser } from "./insomnia-v4";

const raw = readFileSync(join(__dirname, "__fixtures__/insomnia-v4.json"), "utf8");
const parsed = JSON.parse(raw);
const opts = { importEnvironments: true, importScripts: true };

/** A minimal one-workspace export carrying the given resources. */
function doc(...resources: Record<string, unknown>[]): unknown {
	return {
		_type: "export",
		__export_format: 4,
		resources: [{ _id: "w", _type: "workspace", name: "W" }, ...resources],
	};
}

function bearerRequest(authentication: Record<string, unknown>): unknown {
	return doc({
		_id: "r",
		_type: "request",
		parentId: "w",
		name: "R",
		method: "get",
		url: "https://x",
		authentication,
	});
}

describe("InsomniaV4Parser", () => {
	const p = new InsomniaV4Parser();

	/** Parse a doc (or a single request resource) and return its first request draft. */
	const firstRequest = (input: unknown | Record<string, unknown>) => {
		const document =
			(input as { _type?: string })._type === "export"
				? input
				: doc(input as Record<string, unknown>);
		return p.parse(document, "", opts).collections[0].requests[0];
	};

	it("detects by _type+__export_format", () => {
		expect(p.detect(parsed, raw)).toBe(true);
		expect(p.detect({ _type: "export", __export_format: 3 }, "")).toBe(false);
	});

	it("builds workspace root with a request_group child", () => {
		const root = p.parse(parsed, raw, opts).collections[0];
		expect(root.name).toBe("Acme");
		expect(root.children).toHaveLength(1);
		expect(root.children[0].name).toBe("Users");
		expect(root.children[0].auth).toEqual({ mode: "bearer", token: "{{token}}" });
	});

	it("normalizes {{ _.x }} vars in request url/params and maps json body", () => {
		const folder = p.parse(parsed, raw, opts).collections[0].children[0];
		const req = folder.requests[0];
		expect(req.url).toBe("{{baseUrl}}/users");
		expect(req.params).toEqual([
			{ key: "page", value: "1", enabled: true },
			{ key: "trace", value: "1", enabled: false },
		]);
		expect(req.body).toEqual({ mode: "json", content: '{"a":1}' });
	});

	it("places workspace-level request on root and defaults missing auth to inherit", () => {
		const root = p.parse(parsed, raw, opts).collections[0];
		expect(root.requests).toHaveLength(1);
		expect(root.requests[0].name).toBe("Ping");
		expect(root.requests[0].auth).toEqual({ mode: "inherit" });
	});

	it("drops grpc/websocket resources and counts them in meta.skipped", () => {
		const meta = p.parse(parsed, raw, opts).meta;
		expect(meta.skipped.find((s) => s.kind === "grpc")?.count).toBe(1);
	});

	it("flattens sub-environments with base merged, sub winning, values stringified", () => {
		const envs = p.parse(parsed, raw, opts).environments;
		const prod = envs.find((e) => e.name === "Production")!;
		expect(prod.variables.baseUrl.value).toBe("https://prod.acme.com");
		expect(prod.variables.timeout.value).toBe("30");
	});

	it("handles charset-suffixed json mimeType", () => {
		const doc = {
			_type: "export",
			__export_format: 4,
			resources: [
				{ _id: "w", _type: "workspace", name: "W" },
				{
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "post",
					url: "https://x/y",
					body: { mimeType: "application/json; charset=utf-8", text: '{"a":1}' },
				},
			],
		};
		const req = p.parse(doc, JSON.stringify(doc), opts).collections[0].requests[0];
		expect(req.body).toEqual({ mode: "json", content: '{"a":1}' });
	});

	it("disabled auth → none; collection inherit → none", () => {
		const doc = {
			_type: "export",
			__export_format: 4,
			resources: [
				{ _id: "w", _type: "workspace", name: "W" },
				{
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "get",
					url: "https://x",
					authentication: { type: "bearer", token: "T", disabled: true },
				},
			],
		};
		const result = p.parse(doc, JSON.stringify(doc), opts);
		expect(result.collections[0].requests[0].auth).toEqual({ mode: "none" });
		expect(result.collections[0].auth).toEqual({ mode: "none" }); // workspace had no auth → inherit → none
	});

	it("maps iam→aws and ntlm to stored-not-executed config and counts them (parity with Postman)", () => {
		const doc = {
			_type: "export",
			__export_format: 4,
			resources: [
				{ _id: "w", _type: "workspace", name: "W" },
				{
					_id: "r1",
					_type: "request",
					parentId: "w",
					name: "Iam",
					method: "get",
					url: "https://x",
					authentication: { type: "iam", accessKeyId: "AK", secretAccessKey: "SK" },
				},
				{
					_id: "r2",
					_type: "request",
					parentId: "w",
					name: "Ntlm",
					method: "get",
					url: "https://y",
					authentication: { type: "ntlm", username: "u", password: "p" },
				},
			],
		};
		const result = p.parse(doc, JSON.stringify(doc), opts);
		const iam = result.collections[0].requests.find((r) => r.name === "Iam")!;
		const ntlm = result.collections[0].requests.find((r) => r.name === "Ntlm")!;
		expect(iam.auth.mode).toBe("aws");
		expect((iam.auth as { config: Record<string, unknown> }).config.accessKeyId).toBe("AK");
		expect(ntlm.auth.mode).toBe("ntlm");
		expect(result.meta.nonExecutableAuth).toBe(2);
	});

	it("keeps an unlisted text body (YAML) instead of emptying it", () => {
		// XML used to be the example here; it has its own mode now (see below),
		// so the fallback is pinned on a mime that is still genuinely unlisted.
		const req = firstRequest(
			doc({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "Config",
				method: "post",
				url: "https://x",
				body: { mimeType: "text/yaml", text: "id: {{ _.id }}" },
			})
		);
		expect(req.body).toEqual({ mode: "text", content: "id: {{id}}" });
	});

	it("drops a binary body but counts it as file_body", () => {
		const result = p.parse(
			doc({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "Upload",
				method: "post",
				url: "https://x",
				body: { mimeType: "application/octet-stream", fileName: "/tmp/a.bin" },
			}),
			"",
			opts
		);
		expect(result.collections[0].requests[0].body).toEqual({ mode: "none" });
		expect(result.meta.skipped.find((s) => s.kind === "file_body")?.count).toBe(1);
	});

	it("imports a multipart file part as an unresolved file row", () => {
		const result = p.parse(
			doc({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "Form",
				method: "post",
				url: "https://x",
				body: {
					mimeType: "multipart/form-data",
					params: [
						{ name: "note", value: "hi" },
						{ name: "avatar", type: "file", fileName: "/tmp/a.png" },
					],
				},
			}),
			"",
			opts
		);
		// Insomnia keeps the *path* in `fileName`. Before issue #393 the part was
		// dropped and counted, so the request imported as one that uploads nothing.
		expect(result.collections[0].requests[0].body).toEqual({
			mode: "form-data",
			fields: [
				{ key: "note", value: "hi", enabled: true },
				{
					key: "avatar",
					value: "",
					enabled: true,
					type: "file",
					src: "/tmp/a.png",
					fileName: "a.png",
					unresolved: true,
				},
			],
		});
		expect(result.meta.skipped.some((s) => s.kind === "file_body")).toBe(false);
	});

	it("still counts a multipart file param that names no file", () => {
		const result = p.parse(
			doc({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "Form",
				method: "post",
				url: "https://x",
				body: {
					mimeType: "multipart/form-data",
					params: [{ name: "avatar", type: "file" }],
				},
			}),
			"",
			opts
		);
		// Nothing to point at: importing it would produce a part the engine
		// refuses, so it stays reported in the preview instead.
		expect(result.collections[0].requests[0].body).toEqual({ mode: "form-data", fields: [] });
		expect(result.meta.skipped.find((s) => s.kind === "file_body")?.count).toBe(1);
	});

	it("leaves meta.skipped free of file_body when nothing was dropped", () => {
		const meta = p.parse(parsed, raw, opts).meta;
		expect(meta.skipped.some((s) => s.kind === "file_body")).toBe(false);
	});

	it("preserves a non-Bearer bearer prefix as an explicit Authorization header", () => {
		const req = firstRequest(
			bearerRequest({ type: "bearer", token: "{{ _.tok }}", prefix: "Token" })
		);
		expect(req.auth).toEqual({
			mode: "apikey",
			key: "Authorization",
			value: "Token {{tok}}",
			in: "header",
		});
	});

	it("keeps the native bearer mode when the prefix is absent, empty or Bearer", () => {
		for (const prefix of [undefined, "", "  ", "Bearer", "bearer"]) {
			const req = firstRequest(bearerRequest({ type: "bearer", token: "T", prefix }));
			expect(req.auth).toEqual({ mode: "bearer", token: "T" });
		}
	});

	it("imports request_group scripts, and honors importScripts=false", () => {
		const withFolder = doc(
			{
				_id: "g",
				_type: "request_group",
				parentId: "w",
				name: "Users",
				preRequestScript: "console.log('pre')",
				afterResponseScript: "console.log('post')",
			},
			{
				_id: "r",
				_type: "request",
				parentId: "g",
				name: "R",
				method: "get",
				url: "https://x",
			}
		);
		const folder = p.parse(withFolder, "", opts).collections[0].children[0];
		expect(folder.preRequestScript).toBe("console.log('pre')");
		expect(folder.postRequestScript).toBe("console.log('post')");

		const off = p.parse(withFolder, "", { ...opts, importScripts: false }).collections[0]
			.children[0];
		expect(off.preRequestScript).toBe("");
		expect(off.postRequestScript).toBe("");
	});

	it("preserves header and param descriptions", () => {
		const req = firstRequest({
			_id: "r",
			_type: "request",
			parentId: "w",
			name: "R",
			method: "get",
			url: "https://x",
			parameters: [{ name: "page", value: "1", description: "which page" }],
			headers: [{ name: "X-Trace", value: "1", description: "trace id" }],
		});
		expect(req.params[0].description).toBe("which page");
		expect(req.headers[0].description).toBe("trace id");
	});

	it("imports settingFollowRedirects, leaving 'global' to the engine default", () => {
		const draft = (setting?: string) =>
			firstRequest({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "R",
				method: "get",
				url: "https://x",
				...(setting === undefined ? {} : { settingFollowRedirects: setting }),
			});
		expect(draft("off").followRedirects).toBe(false);
		expect(draft("on").followRedirects).toBe(true);
		expect("followRedirects" in draft("global")).toBe(false);
		expect("followRedirects" in draft()).toBe(false);
	});

	/*
	 * The whole `application/graphql` chain was unproven end to end. Insomnia
	 * writes the mime type on a body whose `text` may be either the envelope or
	 * the bare document, and the bare one was stored and sent verbatim: not JSON,
	 * so a GraphQL server reads no query - while the editor's raw-string fallback
	 * made it look healthy.
	 */
	describe("application/graphql", () => {
		const gqlRequest = (text: string, headers: unknown[] = []) => ({
			_id: "r",
			_type: "request",
			parentId: "w",
			name: "R",
			method: "post",
			url: "https://x/graphql",
			headers,
			body: { mimeType: "application/graphql", text },
		});

		it("normalizes a bare query document into the envelope", () => {
			const req = firstRequest(gqlRequest("query B { b }"));
			expect(req.body.mode).toBe("graphql");
			expect(JSON.parse((req.body as { content: string }).content)).toEqual({
				query: "query B { b }",
			});
		});

		it("leaves an envelope alone, operationName included", () => {
			const envelope = JSON.stringify({ query: "query B { b }", operationName: "B" });
			const req = firstRequest(gqlRequest(envelope));
			expect(JSON.parse((req.body as { content: string }).content)).toEqual({
				query: "query B { b }",
				operationName: "B",
			});
		});

		it("normalizes {{ _.x }} vars inside the document", () => {
			const req = firstRequest(gqlRequest("query { user(id: {{ _.userId }}) { id } }"));
			expect(JSON.parse((req.body as { content: string }).content)).toEqual({
				query: "query { user(id: {{userId}}) { id } }",
			});
		});

		it("adds the Content-Type the wire needs", () => {
			expect(firstRequest(gqlRequest("query B { b }")).headers).toEqual([
				{ key: "Content-Type", value: "application/json", enabled: true },
			]);
		});

		it("keeps a Content-Type the export declares", () => {
			const req = firstRequest(
				gqlRequest("query B { b }", [
					{ name: "Content-Type", value: "application/graphql" },
				])
			);
			expect(req.headers).toEqual([
				{ key: "Content-Type", value: "application/graphql", enabled: true },
			]);
		});
	});

	/*
	 * The same chain for XML. Both mimes fell through to `unlistedBody`, which
	 * keeps the text under `text` - readable in the editor, and a mode that
	 * requires no Content-Type, so an imported SOAP request sent its envelope as
	 * `x-www-form-urlencoded`. Mutation check: remove either case from
	 * `insomniaBody` and that mime's mode assertion reddens along with its
	 * header.
	 */
	describe("XML bodies", () => {
		const SOAP = "<soap:Envelope><soap:Body/></soap:Envelope>";
		const xmlRequest = (mimeType: string, headers: unknown[] = []) => ({
			_id: "r",
			_type: "request",
			parentId: "w",
			name: "R",
			method: "post",
			url: "https://x/soap",
			headers,
			body: { mimeType, text: SOAP },
		});

		it.each(["application/xml", "text/xml"])("maps %s to the xml mode", (mime) => {
			const req = firstRequest(xmlRequest(mime));
			expect(req.body.mode).toBe("xml");
			expect((req.body as { content: string }).content).toBe(SOAP);
		});

		it("adds the Content-Type the wire needs", () => {
			expect(firstRequest(xmlRequest("application/xml")).headers).toEqual([
				{ key: "Content-Type", value: "application/xml", enabled: true },
			]);
		});

		it("keeps a declared application/soap+xml", () => {
			// SOAP 1.2's required type, which is exactly the case an importer that
			// overwrote the declared header would break.
			const req = firstRequest(
				xmlRequest("text/xml", [{ name: "Content-Type", value: "application/soap+xml" }])
			);
			expect(req.headers).toEqual([
				{ key: "Content-Type", value: "application/soap+xml", enabled: true },
			]);
		});

		it("normalizes Insomnia's variable syntax inside the document", () => {
			// The behaviour the old unlisted-body case covered for XML, kept where
			// XML lives now: `{{ _.id }}` is Insomnia's spelling of `{{id}}`, and a
			// mode that skipped the normalizer would import a token nothing resolves.
			const req = firstRequest({
				_id: "r",
				_type: "request",
				parentId: "w",
				name: "R",
				method: "post",
				url: "https://x/soap",
				headers: [],
				body: { mimeType: "application/xml", text: "<a>{{ _.id }}</a>" },
			});
			expect(req.body).toEqual({ mode: "xml", content: "<a>{{id}}</a>" });
		});
	});

	describe("malformed exports fail with a named error", () => {
		const cases: Array<[string, unknown]> = [
			["non-array resources", { _type: "export", __export_format: 4, resources: {} }],
			[
				"non-object resource entry",
				{ _type: "export", __export_format: 4, resources: [null] },
			],
			[
				"non-array parameters",
				doc({
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "get",
					url: "https://x",
					parameters: "page=1",
				}),
			],
			[
				"non-array headers",
				doc({
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "get",
					url: "https://x",
					headers: {},
				}),
			],
			[
				"non-array body.params",
				doc({
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "post",
					url: "https://x",
					body: { mimeType: "application/x-www-form-urlencoded", params: "a=1" },
				}),
			],
			[
				"non-string mimeType",
				doc({
					_id: "r",
					_type: "request",
					parentId: "w",
					name: "R",
					method: "post",
					url: "https://x",
					body: { mimeType: 7, text: "x" },
				}),
			],
			[
				// A duplicated `_id` is the only way a v4 file can close a parentId
				// loop; the walk used to recurse until it blew the stack.
				"a folder cycle from a duplicated _id",
				{
					_type: "export",
					__export_format: 4,
					resources: [
						{ _id: "w", _type: "workspace", name: "W" },
						{ _id: "g", _type: "request_group", parentId: "w", name: "G" },
						{ _id: "g2", _type: "request_group", parentId: "g", name: "G2" },
						{ _id: "g", _type: "request_group", parentId: "g2", name: "G again" },
					],
				},
			],
		];
		for (const [label, input] of cases) {
			it(label, () => {
				expect(() => p.parse(input, "", opts)).toThrow(/^Malformed Insomnia export: /);
			});
		}
	});

	it("base environment with no sub-envs becomes one Environment named after the base", () => {
		const doc = {
			_type: "export",
			__export_format: 4,
			resources: [
				{ _id: "w", _type: "workspace", name: "W" },
				{ _id: "e", _type: "environment", parentId: "w", name: "Base", data: { k: 1 } },
			],
		};
		const envs = p.parse(doc, JSON.stringify(doc), opts).environments;
		expect(envs).toHaveLength(1);
		expect(envs[0].name).toBe("Base");
		expect(envs[0].variables.k.value).toBe("1");
	});
});
