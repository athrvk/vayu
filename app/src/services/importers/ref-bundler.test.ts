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
 * load-bearing assertions here are the ones that go through a *parser*: the
 * request body stub is only non-empty if the ref actually reached the schema in
 * the other file. Revert the bundling call and those reds; assertions about the
 * bundled text alone would not.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
	bundleExternalRefs,
	BUNDLE_KEY,
	SpecBundleTooLargeError,
	type ExternalRefIntake,
} from "./ref-bundler";
import { parseImport } from "./factory";
import { createRefResolver } from "./openapi-shared";

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
		readSibling: vi.fn(async (relativePath: string) =>
			readFileSync(resolve(dirname(ENTRY), relativePath), "utf8")
		),
		...overrides,
	};
}

const opts = { importEnvironments: true, importScripts: true };

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
		expect(result).toEqual({ text: "{ not: [json", bundled: 0, unresolvedRefs: 0 });
	});
});

describe("bundleExternalRefs - sibling files", () => {
	it("resolves the schema a ref names, so the operation imports what it declared", async () => {
		const { text, bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, fileIntake());
		expect(bundled).toBe(2);
		expect(unresolvedRefs).toBe(0);

		const request = parseImport(text, opts).collections[0].children[0].requests[0];
		const body = request.body;
		expect(body.mode).toBe("json");
		// Before bundling this stub was `{}`: the ref resolved to `undefined` and
		// the sampler had nothing to sample.
		expect(JSON.parse("content" in body ? body.content : "{}")).toEqual({
			id: 7,
			name: "Rex",
			tag: { label: "good-boy" },
		});
	});

	it("resolves a ref that climbs out of the spec's own directory", async () => {
		const { text } = await bundleExternalRefs(entryRaw, fileIntake());
		const example = parseImport(
			text,
			opts
		).collections[0].children[0].requests[0].examples?.find((e) => e.status === 400);
		expect(JSON.parse(example!.body)).toEqual({ code: 400, message: "pet already exists" });
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
		expect(createRefResolver(doc)(tagRef)).toEqual(bundle[pet[0]].Tag);
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
		const fetchUrl = vi.fn(
			async () => "Pet:\n  type: object\n  properties:\n    id:\n      type: integer\n"
		);
		const { bundled, unresolvedRefs } = await bundleExternalRefs(urlSpec, {
			maxBytes: ROOMY,
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
			readSibling,
		});
		expect(bundled).toBe(2);
		expect(unresolvedRefs).toBe(0);
		// The chain is walkable end to end in the bundled document, which is the
		// only thing a parser can do with it.
		const doc = JSON.parse(text) as Record<string, unknown>;
		const resolve = createRefResolver(doc);
		const a = resolve("#/components/schemas/A") as { $ref: string };
		const b = resolve(a.$ref) as { $ref: string };
		expect(resolve(b.$ref)).toEqual({ type: "string" });
	});

	it("terminates on a cycle, reading each file once", async () => {
		const cyclic: Record<string, string> = {
			"b.json": JSON.stringify({ B: { $ref: "./c.json#/C" } }),
			"c.json": JSON.stringify({ C: { $ref: "./b.json#/B" } }),
		};
		const readSibling = vi.fn(async (path: string) => cyclic[path]);
		const { bundled } = await bundleExternalRefs(spec, { maxBytes: ROOMY, readSibling });
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
			readSibling,
		});
		expect(unresolvedRefs).toBe(3);
		expect(text).toContain("./schemas/pet.json#/Pet");
	});

	it("counts an unparseable target rather than bundling garbage", async () => {
		const readSibling = vi.fn(async () => "{ not: [json");
		const { bundled, unresolvedRefs } = await bundleExternalRefs(entryRaw, {
			maxBytes: ROOMY,
			readSibling,
		});
		expect(bundled).toBe(0);
		expect(unresolvedRefs).toBe(3);
	});

	it("surfaces the count through the import preview's skip tally", async () => {
		const { text, unresolvedRefs } = await bundleExternalRefs(entryRaw, { maxBytes: ROOMY });
		const meta = parseImport(text, opts, { unresolvedRefs }).meta;
		expect(meta.skipped).toContainEqual({ kind: "external_ref", count: 3 });
	});
});

describe("bundleExternalRefs - the engine's cap", () => {
	it("refuses a bundle over it, naming the size and the setting", async () => {
		const readSibling = vi.fn(async () =>
			JSON.stringify({ Pet: { type: "object" } }).padEnd(4000)
		);
		await expect(bundleExternalRefs(entryRaw, { maxBytes: 2048, readSibling })).rejects.toThrow(
			SpecBundleTooLargeError
		);
		await expect(bundleExternalRefs(entryRaw, { maxBytes: 2048, readSibling })).rejects.toThrow(
			/over the 2048 one document may hold.*maxSpecDocumentBytes/s
		);
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
			bundleExternalRefs(oversized, { maxBytes: 2048, readSibling })
		).rejects.toThrow(SpecBundleTooLargeError);
		await expect(
			bundleExternalRefs(oversized, { maxBytes: 2048, readSibling })
		).rejects.toThrow(/The spec is 4096 bytes, over the 2048.*maxSpecDocumentBytes/s);
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
		await expect(bundleExternalRefs(collection, { maxBytes: 2048 })).resolves.toEqual({
			text: collection,
			bundled: 0,
			unresolvedRefs: 0,
		});
	});

	it("follows the setting rather than a hard-coded copy", async () => {
		const readSibling = vi.fn(async () =>
			JSON.stringify({ Pet: { type: "object" } }).padEnd(4000)
		);
		await expect(
			bundleExternalRefs(entryRaw, { maxBytes: 1024 * 1024, readSibling })
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
