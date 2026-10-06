/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What bundling has to get right (issue #649).
 *
 * The defect it closes is invisible by construction - an external `$ref` used to
 * resolve to `undefined` and the import simply came out smaller - so the
 * load-bearing assertions are the ones that walk the *bundled document* and
 * find the schema the ref named actually there, under a pointer this document
 * can resolve. Revert the bundling call and those go red.
 *
 * They used to run a *parser* over the bundled text and assert on the request
 * body it produced. That parser is engine-side now (issue #877), and the
 * substitution is not a loss: what bundling promises is a walkable document,
 * and what a reader then makes of it is pinned by the engine's own conformance
 * corpus rather than by this file.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
	bundleExternalRefs,
	BUNDLE_KEY,
	isLocalAddress,
	RefRefusedError,
	SpecBundleTooLargeError,
	type ExternalRefIntake,
} from "./ref-bundler";

/**
 * A JSON Pointer walk, here rather than imported: the importer's own resolver
 * went engine-side with the parsers (issue #877), and what these cases need is
 * not a parser at all - it is whether the *bundled document* is walkable, which
 * is the bundler's whole output.
 */
function resolveRef(document: unknown, ref: string): unknown {
	let node: unknown = document;
	for (const raw of ref.replace(/^#\//, "").split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		node =
			typeof node === "object" && node !== null
				? (node as Record<string, unknown>)[segment]
				: undefined;
	}
	return node;
}

/**
 * How the bundler reads a document into a tree. In production that is the
 * engine (`POST /import/document`), which is the point - the renderer holds no
 * reader (issue #877). Injected here so the walk can be driven with no engine
 * running; every fixture below is JSON, and what a document's *bytes* are is
 * pinned engine-side by `import_parse_test.cpp`.
 */
const parseDocument = async (text: string): Promise<unknown> => JSON.parse(text);

const MULTIFILE = join(__dirname, "__fixtures__/openapi-v3-multifile");
const ENTRY = join(MULTIFILE, "spec/openapi.json");
const entryRaw = readFileSync(ENTRY, "utf8");
const singleFileRaw = readFileSync(join(__dirname, "__fixtures__/openapi-v3.json"), "utf8");

/** A cap no fixture comes near, so a size test has to set its own. */
const ROOMY = 10 * 1024 * 1024;

/**
 * The file intake, as Electron's `specFile:read` behaves: the *ref's own path*
 * arrives, resolved in the main process against the picked document's directory.
 */
function fileIntake(overrides: Partial<ExternalRefIntake> = {}): ExternalRefIntake {
	return {
		maxBytes: ROOMY,
		parseDocument,
		readSibling: vi.fn(async (relativePath: string) =>
			readFileSync(resolve(dirname(ENTRY), relativePath), "utf8")
		),
		...overrides,
	};
}

describe("bundleExternalRefs - a document with nothing external", () => {
	it("returns the input byte for byte", async () => {
		// `SpecDraft` promises the engine the document verbatim, and that promise
		// is kept for every single-file spec - the common case. Re-serializing here
		// would make every YAML spec drift on its first sync.
		const result = await bundleExternalRefs(singleFileRaw, fileIntake());
		expect(result.text).toBe(singleFileRaw);
		expect(result.bundled).toBe(0);
		expect(result.unresolvedRefs).toBe(0);
	});

	it("does not walk a format that has no external refs to walk", async () => {
		const postman = readFileSync(join(__dirname, "__fixtures__/postman-v21.json"), "utf8");
		const intake = fileIntake();
		const result = await bundleExternalRefs(postman, intake);
		expect(result.text).toBe(postman);
		expect(intake.readSibling).not.toHaveBeenCalled();
	});

	it("hands unparseable text back untouched, for the detector to report", async () => {
		const result = await bundleExternalRefs("{ not: [json", fileIntake());
		expect(result).toEqual({
			text: "{ not: [json",
			bundled: 0,
			unresolvedRefs: 0,
			fetched: [],
			refused: [],
		});
	});
});

describe("bundleExternalRefs - sibling files", () => {
	it("resolves the schema a ref names, so the operation imports what it declared", async () => {
		const { text, bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, fileIntake());
		expect(bundled).toBe(2);
		expect(unresolvedRefs).toBe(0);

		// Before bundling, the request body's schema `$ref` named a file and
		// resolved to nothing at all - the sampler had nothing to sample and the
		// operation imported with an empty stub. The assertion is that it is
		// walkable *in this document*, which is the only thing bundling promises
		// and the only thing a reader of it can use.
		const doc = JSON.parse(text) as Record<string, unknown>;
		const schemaRef = (
			resolveRef(doc, "#/paths/~1pets/post/requestBody/content/application~1json/schema") as {
				$ref: string;
			}
		).$ref;
		expect(schemaRef.startsWith(`#/${BUNDLE_KEY}/`)).toBe(true);
		expect(resolveRef(doc, schemaRef)).toMatchObject({ type: "object" });
	});

	it("hands a ref that climbs to the intake untouched, which is where it is confined", async () => {
		// The bundler cannot know the picked folder's root; `batch.ts` and the main
		// process's `specFile:read` decide whether `../shared/error.json` stays
		// inside it (#1782), and a refusal comes back as a `RefRefusedError`.
		const intake = fileIntake();
		const { bundled } = await bundleExternalRefs(entryRaw, intake);
		expect(bundled).toBe(2);
		const reads = (intake.readSibling as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(reads).toContain("../shared/error.json");
	});

	it("reads each target once however many refs name it", async () => {
		// `pet.json` is referenced twice (the body and the 201 response).
		const intake = fileIntake();
		await bundleExternalRefs(entryRaw, intake);
		const reads = (intake.readSibling as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		// Relative to the picked document, `..` and all - resolving it is the main
		// process's job, and collapsing it here would name a different file.
		expect(reads.sort()).toEqual(["../shared/error.json", "schemas/pet.json"]);
	});

	it("rewrites a bundled file's own in-document refs into its subtree", async () => {
		// `pet.json` says `{"$ref": "#/Tag"}`, which means Tag *in pet.json*. Left
		// alone it would resolve against the root document, where there is no Tag.
		const { text } = await bundleExternalRefs(entryRaw, fileIntake());
		const doc = JSON.parse(text) as Record<string, unknown>;
		const bundle = doc[BUNDLE_KEY] as Record<string, Record<string, unknown>>;
		const pet = Object.entries(bundle).find(([slug]) => slug.startsWith("pet.json-"))!;
		const tagRef = (
			(pet[1].Pet as Record<string, Record<string, Record<string, string>>>).properties
				.tag as unknown as { $ref: string }
		).$ref;
		expect(tagRef).toBe(`#/${BUNDLE_KEY}/${pet[0]}/Tag`);
		expect(resolveRef(doc, tagRef)).toEqual(bundle[pet[0]].Tag);
	});
});

describe("bundleExternalRefs - URLs", () => {
	const urlSpec = JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Remote", version: "1" },
		paths: {
			"/pets": {
				get: {
					operationId: "listPets",
					responses: {
						"200": {
							description: "ok",
							content: {
								"application/json": { schema: { $ref: "./defs/pet.yaml#/Pet" } },
							},
						},
					},
				},
			},
		},
	});

	it("resolves a relative ref against the URL the document was fetched from", async () => {
		const fetchUrl = vi.fn(async () =>
			JSON.stringify({ Pet: { type: "object", properties: { id: { type: "integer" } } } })
		);
		const { bundled, unresolvedRefs } = await bundleExternalRefs(urlSpec, {
			maxBytes: ROOMY,
			parseDocument,
			sourceUrl: "https://acme.dev/specs/openapi.json",
			fetchUrl,
		});
		expect(fetchUrl).toHaveBeenCalledWith("https://acme.dev/specs/defs/pet.yaml");
		expect(bundled).toBe(1);
		expect(unresolvedRefs).toBe(0);
	});

	it("fetches an absolute ref even when the document came off disk", async () => {
		const absolute = urlSpec.replace("./defs/pet.yaml", "https://acme.dev/common.json");
		const fetchUrl = vi.fn(async () => JSON.stringify({ Pet: { type: "object" } }));
		const intake = fileIntake({ fetchUrl });
		const { bundled } = await bundleExternalRefs(absolute, intake);
		expect(fetchUrl).toHaveBeenCalledWith("https://acme.dev/common.json");
		expect(intake.readSibling).not.toHaveBeenCalled();
		expect(bundled).toBe(1);
	});
});

describe("bundleExternalRefs - transitive refs and cycles", () => {
	const chain: Record<string, string> = {
		"b.json": JSON.stringify({ B: { $ref: "./c.json#/C" } }),
		"c.json": JSON.stringify({ C: { type: "string" } }),
	};
	const spec = JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Chain", version: "1" },
		components: { schemas: { A: { $ref: "./b.json#/B" } } },
		paths: {},
	});

	it("follows a ref through a file that refers to a third", async () => {
		const readSibling = vi.fn(async (path: string) => chain[path]);
		const { bundled, unresolvedRefs, text } = await bundleExternalRefs(spec, {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(bundled).toBe(2);
		expect(unresolvedRefs).toBe(0);
		// The chain is walkable end to end in the bundled document, which is the
		// only thing a parser can do with it.
		const doc = JSON.parse(text) as Record<string, unknown>;
		const a = resolveRef(doc, "#/components/schemas/A") as { $ref: string };
		const b = resolveRef(doc, a.$ref) as { $ref: string };
		expect(resolveRef(doc, b.$ref)).toEqual({ type: "string" });
	});

	it("terminates on a cycle, reading each file once", async () => {
		const cyclic: Record<string, string> = {
			"b.json": JSON.stringify({ B: { $ref: "./c.json#/C" } }),
			"c.json": JSON.stringify({ C: { $ref: "./b.json#/B" } }),
		};
		const readSibling = vi.fn(async (path: string) => cyclic[path]);
		const { bundled } = await bundleExternalRefs(spec, {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(bundled).toBe(2);
		expect(readSibling).toHaveBeenCalledTimes(2);
	});
});

describe("bundleExternalRefs - what it cannot reach is said out loud", () => {
	it("counts a relative ref in a document with no directory and no URL", async () => {
		// A pasted spec. Two refs name `pet.json`, and both are operations that
		// imported short - so both are counted, not the one file.
		const { text, bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, {
			maxBytes: ROOMY,
			parseDocument,
		});
		expect(bundled).toBe(0);
		expect(unresolvedRefs).toBe(3);
		expect(text).toBe(entryRaw);
	});

	it("counts a file that is not there, and leaves the ref as the document wrote it", async () => {
		const readSibling = vi.fn(async () => {
			throw new Error("The spec references schemas/pet.json, which is not at /tmp/x");
		});
		const { text, unresolvedRefs } = await bundleExternalRefs(entryRaw, {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(unresolvedRefs).toBe(3);
		expect(text).toContain("./schemas/pet.json#/Pet");
	});

	it("counts an unparseable target rather than bundling garbage", async () => {
		const readSibling = vi.fn(async () => "{ not: [json");
		const { bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(bundled).toBe(0);
		expect(unresolvedRefs).toBe(3);
	});

	// The count leaving here is what the preview reports: `parseImport` passes it
	// to the engine, which stamps it into `meta.skipped` as `external_ref`
	// (pinned engine-side by `import_parse_test.cpp`). What this file owns is
	// that the number is right and that it survives the bundle.
	it("counts every ref it could not reach, once each", async () => {
		const { text, bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, {
			maxBytes: ROOMY,
			parseDocument,
		});
		expect(bundled).toBe(0);
		expect(unresolvedRefs).toBe(3);
		// Nothing was resolved, so the document is returned byte for byte.
		expect(text).toBe(entryRaw);
	});
});

describe("bundleExternalRefs - the engine's cap", () => {
	it("refuses a bundle over it, naming the size and the setting", async () => {
		const readSibling = vi.fn(async () =>
			JSON.stringify({ Pet: { type: "object" } }).padEnd(4000)
		);
		await expect(
			bundleExternalRefs(entryRaw, { maxBytes: 2048, parseDocument, readSibling })
		).rejects.toThrow(SpecBundleTooLargeError);
		await expect(
			bundleExternalRefs(entryRaw, { maxBytes: 2048, parseDocument, readSibling })
		).rejects.toThrow(/over the 2\.0 KB one document may hold.*Max OpenAPI Document Size/s);
	});

	/**
	 * Issue #719. The running total was only ever compared after an external
	 * document had been loaded, so a spec that references nothing - which is what
	 * the generated multi-megabyte documents are - passed bundling whatever its
	 * size and was first refused by the engine at apply, after the user had
	 * confirmed a preview built from it.
	 */
	it("refuses a single over-cap document before it is parsed, naming the setting", async () => {
		const oversized = singleFileRaw.padEnd(4096);
		const readSibling = vi.fn(async () => "{}");
		await expect(
			bundleExternalRefs(oversized, { maxBytes: 2048, parseDocument, readSibling })
		).rejects.toThrow(SpecBundleTooLargeError);
		await expect(
			bundleExternalRefs(oversized, { maxBytes: 2048, parseDocument, readSibling })
		).rejects.toThrow(/The spec is 4\.0 KB, over the 2\.0 KB.*Max OpenAPI Document Size/s);
		// Before parse, and before a single ref is followed: the point of moving
		// the check is that nothing downstream runs on a document that cannot be
		// stored.
		expect(readSibling).not.toHaveBeenCalled();
	});

	it("leaves a document that is not a spec alone, whatever its size", async () => {
		// The cap is the *spec document* cap. A Postman collection is stored as
		// collections and requests, so it has no such limit to be measured against.
		const collection = JSON.stringify({
			info: { name: "Big", schema: "https://schema.getpostman.com/json/collection/v2.1.0/" },
			item: [],
		}).padEnd(4096);
		await expect(
			bundleExternalRefs(collection, { maxBytes: 2048, parseDocument })
		).resolves.toEqual({
			text: collection,
			bundled: 0,
			unresolvedRefs: 0,
			fetched: [],
			refused: [],
		});
	});

	it("follows the setting rather than a hard-coded copy", async () => {
		const readSibling = vi.fn(async () =>
			JSON.stringify({ Pet: { type: "object" } }).padEnd(4000)
		);
		await expect(
			bundleExternalRefs(entryRaw, { maxBytes: 1024 * 1024, parseDocument, readSibling })
		).resolves.toBeTruthy();
	});
});

describe("bundleExternalRefs - determinism", () => {
	it("produces the same bytes for the same inputs", async () => {
		// Sync decides "unchanged" by hashing this text (#627), so a bundle that
		// varied by iteration order would report every re-fetch as a change.
		const first = await bundleExternalRefs(entryRaw, fileIntake());
		const second = await bundleExternalRefs(entryRaw, fileIntake());
		expect(first.text).toBe(second.text);
	});

	it("names a bundled document after the target, not the order it was read", async () => {
		const swapped = entryRaw
			.replace("./schemas/pet.json#/Pet", "PET_ONE")
			.replace("../shared/error.json#/Error", "./schemas/pet.json#/Pet")
			.replace("PET_ONE", "../shared/error.json#/Error");
		const original = JSON.parse(
			(await bundleExternalRefs(entryRaw, fileIntake())).text
		) as Record<string, Record<string, unknown>>;
		const reordered = JSON.parse(
			(await bundleExternalRefs(swapped, fileIntake())).text
		) as Record<string, Record<string, unknown>>;
		expect(Object.keys(reordered[BUNDLE_KEY])).toEqual(Object.keys(original[BUNDLE_KEY]));
	});
});

describe("bundleExternalRefs - what a spec may make Vayu fetch or read (#1782)", () => {
	const specReferencing = (target: string) =>
		JSON.stringify({
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {
				"/p": {
					get: {
						responses: {
							"200": {
								description: "ok",
								content: {
									"application/json": { schema: { $ref: `${target}#/Pet` } },
								},
							},
						},
					},
				},
			},
		});

	it.each([
		"http://localhost:8080/x.json",
		"http://127.0.0.1/x.json",
		"http://127.1.2.3/x.json",
		"http://169.254.169.254/latest/meta-data.json",
		"http://[::1]/x.json",
		"http://[fe80::1]/x.json",
		"http://[::ffff:127.0.0.1]/x.json",
		"http://[::ffff:169.254.169.254]/latest/meta-data.json",
		"http://0.0.0.0/x.json",
		"http://[::]/x.json",
		"http://localhost./x.json",
	])("refuses to fetch %s for a reference, and names it", async (url) => {
		const fetchUrl = vi.fn(async () => "{}");
		const result = await bundleExternalRefs(specReferencing(url), {
			maxBytes: ROOMY,
			parseDocument,
			fetchUrl,
		});
		expect(fetchUrl).not.toHaveBeenCalled();
		expect(result.refused).toHaveLength(1);
		expect(result.refused[0].target).toContain(new URL(url).hostname.replace(/[[\]]/g, ""));
		expect(result.unresolvedRefs).toBe(1);
	});

	it("fetches an ordinary host and lists it as fetched", async () => {
		const fetchUrl = vi.fn(async () => JSON.stringify({ Pet: { type: "object" } }));
		const result = await bundleExternalRefs(specReferencing("https://acme.dev/c.json"), {
			maxBytes: ROOMY,
			parseDocument,
			fetchUrl,
		});
		expect(result.fetched).toEqual(["https://acme.dev/c.json"]);
		expect(result.refused).toEqual([]);
	});

	it("lets a spec served from a local dev server reference its own host", async () => {
		const fetchUrl = vi.fn(async () => JSON.stringify({ Pet: { type: "object" } }));
		const result = await bundleExternalRefs(specReferencing("./c.json"), {
			maxBytes: ROOMY,
			parseDocument,
			sourceUrl: "http://localhost:3000/openapi.json",
			fetchUrl,
		});
		expect(fetchUrl).toHaveBeenCalledWith("http://localhost:3000/c.json");
		expect(result.refused).toEqual([]);
	});

	it("still refuses a different local host than the one the spec came from", async () => {
		const fetchUrl = vi.fn(async () => "{}");
		const result = await bundleExternalRefs(specReferencing("http://localhost:9999/c.json"), {
			maxBytes: ROOMY,
			parseDocument,
			sourceUrl: "http://localhost:3000/openapi.json",
			fetchUrl,
		});
		expect(fetchUrl).not.toHaveBeenCalled();
		expect(result.refused).toHaveLength(1);
	});

	it("names a local ref the intake declined on purpose, but not one that was merely missing", async () => {
		const readSibling = vi.fn(async (key: string) => {
			if (key === "gone.json") throw new Error("not there");
			throw new RefRefusedError();
		});
		const declined = await bundleExternalRefs(specReferencing("./nope.json"), {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(declined.refused).toEqual([
			{ target: "nope.json", reason: "outside the folder that was picked" },
		]);
		const missing = await bundleExternalRefs(specReferencing("./gone.json"), {
			maxBytes: ROOMY,
			parseDocument,
			readSibling,
		});
		expect(missing.refused).toEqual([]);
		expect(missing.unresolvedRefs).toBe(1);
	});
});

describe("isLocalAddress", () => {
	it("is false for public hosts and near-miss names", () => {
		for (const url of [
			"https://example.com/x",
			"https://localhost.example.com/x",
			"https://128.0.0.1/x",
			"https://169.255.0.1/x",
			"https://[::ffff:8.8.8.8]/x",
			"https://[::ffff:808:808]/x",
			"https://[2001:db8::1]/x",
			"not a url",
		]) {
			expect(isLocalAddress(url)).toBe(false);
		}
	});

	it.each([
		["dotted IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/x"],
		["dotted IPv4-mapped metadata address", "http://[::ffff:169.254.169.254]/x"],
		["hex IPv4-mapped loopback", "http://[::ffff:7f00:1]/x"],
		["hex IPv4-mapped metadata address", "http://[::ffff:a9fe:a9fe]/x"],
		["IPv4-mapped 127/8 beyond .1", "http://[::ffff:7f12:3456]/x"],
		["unspecified IPv4", "http://0.0.0.0/x"],
		["unspecified IPv6", "http://[::]/x"],
		["localhost with a trailing dot", "http://localhost./x"],
		["a .localhost name with a trailing dot", "http://app.localhost./x"],
		["loopback IPv4 with a trailing dot", "http://127.0.0.1./x"],
	])("is true for %s", (_name, url) => {
		expect(isLocalAddress(url)).toBe(true);
	});
});
