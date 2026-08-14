import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseImport } from "./factory";
import { UnrecognisedFormatError } from "./types";

const opts = { importEnvironments: true, importScripts: true };
const fx = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("parseImport", () => {
	it("routes Postman v2.1", () => {
		expect(parseImport(fx("postman-v21.json"), opts).meta.format).toBe(
			"Postman Collection v2.1"
		);
	});
	it("routes Postman v2.0", () => {
		expect(parseImport(fx("postman-v20.json"), opts).meta.format).toBe(
			"Postman Collection v2.0"
		);
	});
	it("routes a Postman environment export", () => {
		const r = parseImport(fx("postman-environment.json"), opts);
		expect(r.meta.format).toBe("Postman Environment");
		expect(r.collections).toEqual([]);
		expect(r.environments).toHaveLength(1);
	});
	it("still routes a Postman collection to the collection parser", () => {
		// The environment detector sits between v2.0 and Insomnia; a collection
		// export must not fall through to it.
		expect(parseImport(fx("postman-v21.json"), opts).meta.format).toBe(
			"Postman Collection v2.1"
		);
	});
	it("routes a Postman globals export, reporting it as its own format", () => {
		const r = parseImport(fx("postman-globals.json"), opts);
		expect(r.meta.format).toBe("Postman Globals");
		// Same parser as the environment export, but the variables land in the
		// globals scope rather than becoming a named environment.
		expect(r.environments).toHaveLength(0);
		expect(Object.keys(r.globals)).toContain("apiHost");
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
	it("propagates a YAML parse error on genuinely malformed input", () => {
		// Unclosed flow mapping → js-yaml throws YAMLException (NOT UnrecognisedFormatError).
		let err: unknown;
		try {
			parseImport("{ unclosed: [1, 2", opts);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(UnrecognisedFormatError);
	});

	it("throws UnrecognisedFormatError on empty input", () => {
		expect(() => parseImport("", opts)).toThrow(UnrecognisedFormatError);
	});

	it("throws UnrecognisedFormatError on a bare YAML scalar", () => {
		expect(() => parseImport("42", opts)).toThrow(UnrecognisedFormatError);
	});
});

/**
 * Issue #590. Each parser states the query its own way - Postman splits it out
 * of the URL, Insomnia keeps a `parameters[]` beside the URL, OpenAPI invents
 * params for a URL that never had a query - and every execution path sends
 * `url` verbatim. So the URL a parser hands on has to already carry the enabled
 * params, or they never reach the wire.
 *
 * Asserted through `parseImport`, not the parsers: the parsers' own split is
 * still their contract (their suites pin it), and this join is the one rule
 * applied above all of them.
 */
describe("parseImport joins enabled params into the request URL", () => {
	it("Postman: the split query comes back, minus the disabled row", () => {
		const req = parseImport(fx("postman-v21.json"), opts).collections[0].children[0]
			.requests[0];
		expect(req.url).toBe("{{baseUrl}}/users?page=1");
		// The table keeps both rows: `params[]` is what the source declared, and
		// the disabled one has to stay visible to be re-enabled.
		expect(req.params).toEqual([
			{ key: "page", value: "1", enabled: true },
			{ key: "trace", value: "1", enabled: false },
		]);
	});

	it("Postman: a request with no query is untouched", () => {
		const req = parseImport(fx("postman-v21.json"), opts).collections[0].requests[0];
		expect(req.url).toBe("{{baseUrl}}/users");
	});

	it("Insomnia: `parameters[]` joins the URL, disabled row excluded", () => {
		const root = parseImport(fx("insomnia-v4.json"), opts).collections[0];
		const all = [...root.requests, ...root.children.flatMap((c) => c.requests)];
		const req = all.find((r) => r.params.length > 0);
		expect(req?.url).toBe("{{baseUrl}}/users?page=1");
		expect(req?.params.map((p) => [p.key, p.enabled])).toEqual([
			["page", true],
			["trace", false],
		]);
	});

	it("Insomnia: a query written inline in the URL survives the join", () => {
		/*
		 * The append-vs-replace trap. Insomnia's `url` is taken verbatim and its
		 * `parameters[]` is a separate list, so both can carry query state - and
		 * appending them is what Insomnia itself does on send. Rebuilding the URL
		 * from `params[]` alone (the Params table's rule) would delete the `a=1`
		 * the source put in the URL, silently.
		 */
		const doc = JSON.stringify({
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
					url: "https://x/y?a=1",
					parameters: [{ name: "b", value: "2" }],
				},
			],
		});
		expect(parseImport(doc, opts).collections[0].requests[0].url).toBe("https://x/y?a=1&b=2");
	});

	it("OpenAPI: a declared query parameter reaches the URL as a valueless key", () => {
		// The stub parsers carry no values (`docs/app/import-collections/openapi-v3.md`),
		// so a declared parameter joins as a bare key - the same thing the Params
		// table writes for a keyed row the user has not filled in yet.
		const root = parseImport(fx("openapi-v3.json"), opts).collections[0];
		const all = [...root.requests, ...root.children.flatMap((c) => c.requests)];
		const pets = all.find((r) => r.url.includes("/pets/{{petId}}"));
		expect(pets?.url).toBe("{{baseUrl}}/pets/{{petId}}?verbose");
	});
});
