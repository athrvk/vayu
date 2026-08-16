/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The re-import lookup (issue #680).
 *
 * The three outcomes the dialog forks on are all decided here: bound and
 * identical, bound and moved since, and not bound at all. Each is pinned
 * separately because they arrive by different keys - bytes for the first, the
 * URL for the second - and a lookup that kept only one of them would still pass
 * a test that asserted "a bound document is found".
 */

import { describe, it, expect } from "vitest";
import {
	boundCollections,
	matchBoundSpecs,
	specCandidates,
	type BoundSpec,
} from "./bound-spec-match";
import type { BatchEntry } from "@/services/importers/batch";
import type { Collection } from "@/types";
import type { ImportResult } from "@/services/importers/types";

const PETSTORE = '{"openapi":"3.0.0","info":{"title":"Petstore"}}';
const PETSTORE_V2 = '{"openapi":"3.0.0","info":{"title":"Petstore","version":"2"}}';

function collection(id: string, name: string, specId?: string): Collection {
	return {
		id,
		name,
		description: "",
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		order: 0,
		createdAt: "",
		updatedAt: "",
		...(specId ? { openapi: { specId, specHash: "abc", syncedAt: 1 } } : {}),
	};
}

function boundSpec(overrides: Partial<BoundSpec> = {}): BoundSpec {
	return {
		collectionId: "col_1",
		collectionName: "Petstore",
		specId: "spec_1",
		sourceUrl: null,
		content: PETSTORE,
		...overrides,
	};
}

function candidate(overrides: Partial<Parameters<typeof matchBoundSpecs>[0][number]> = {}) {
	return {
		entryId: "e1",
		label: "openapi.json",
		content: PETSTORE,
		...overrides,
	};
}

describe("boundCollections", () => {
	it("keeps the collections that name a document, and nothing else", () => {
		const found = boundCollections([
			collection("col_1", "Petstore", "spec_1"),
			collection("col_2", "Scratch"),
		]);
		expect(found).toEqual([
			{ collectionId: "col_1", collectionName: "Petstore", specId: "spec_1" },
		]);
	});
});

describe("matchBoundSpecs", () => {
	it("finds the collection bound to a byte-identical document", () => {
		expect(matchBoundSpecs([candidate()], [boundSpec()])).toEqual([
			{
				entryId: "e1",
				label: "openapi.json",
				collectionId: "col_1",
				collectionName: "Petstore",
				matchedBy: "content",
			},
		]);
	});

	/**
	 * The case Sync exists for, and the one a content comparison cannot see: the
	 * bytes are exactly what changed. Remove the URL key and this is a clean miss,
	 * which is the silent second collection the issue is about.
	 */
	it("finds it by URL when the document has moved since it was bound", () => {
		const matches = matchBoundSpecs(
			[candidate({ content: PETSTORE_V2, sourceUrl: "https://acme.dev/openapi.json" })],
			[boundSpec({ sourceUrl: "https://acme.dev/openapi.json" })]
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.matchedBy).toBe("sourceUrl");
	});

	it("matches nothing when neither key does", () => {
		expect(
			matchBoundSpecs(
				[candidate({ content: PETSTORE_V2, sourceUrl: "https://other.dev/openapi.json" })],
				[boundSpec({ sourceUrl: "https://acme.dev/openapi.json" })]
			)
		).toEqual([]);
	});

	it("matches nothing when no collection is bound at all", () => {
		expect(matchBoundSpecs([candidate()], [])).toEqual([]);
	});

	/**
	 * A file or a paste has no URL, and a stored document that came from a file
	 * has `null` - two absent values that must not be read as the same address.
	 */
	it("does not treat two missing URLs as the same URL", () => {
		const matches = matchBoundSpecs(
			[candidate({ content: PETSTORE_V2 })],
			[boundSpec({ sourceUrl: null })]
		);
		expect(matches).toEqual([]);
	});

	it("compares URLs as written - a trailing slash is a different address", () => {
		expect(
			matchBoundSpecs(
				[candidate({ content: PETSTORE_V2, sourceUrl: "https://acme.dev/openapi.json/" })],
				[boundSpec({ sourceUrl: "https://acme.dev/openapi.json" })]
			)
		).toEqual([]);
	});

	it("prefers the URL match over a byte match on another collection", () => {
		const matches = matchBoundSpecs(
			[candidate({ sourceUrl: "https://acme.dev/openapi.json" })],
			[
				boundSpec({ collectionId: "col_bytes", collectionName: "Copy", content: PETSTORE }),
				boundSpec({
					collectionId: "col_url",
					collectionName: "Live",
					specId: "spec_2",
					sourceUrl: "https://acme.dev/openapi.json",
					content: PETSTORE_V2,
				}),
			]
		);
		expect(matches[0]).toMatchObject({ collectionId: "col_url", matchedBy: "sourceUrl" });
	});

	it("reports one match per document in a batch, each naming its own file", () => {
		const matches = matchBoundSpecs(
			[
				candidate({ entryId: "e1", label: "pets.json" }),
				candidate({ entryId: "e2", label: "orders.json", content: PETSTORE_V2 }),
			],
			[
				boundSpec(),
				boundSpec({
					collectionId: "col_2",
					collectionName: "Orders",
					specId: "spec_2",
					content: PETSTORE_V2,
				}),
			]
		);
		expect(matches.map((m) => [m.label, m.collectionName])).toEqual([
			["pets.json", "Petstore"],
			["orders.json", "Orders"],
		]);
	});
});

describe("specCandidates", () => {
	function entry(over: Partial<BatchEntry>): BatchEntry {
		return {
			id: "e1",
			fileName: "openapi.json",
			relativePath: "openapi.json",
			specPath: "",
			sourceUrl: "",
			raw: PETSTORE,
			unresolvedRefs: 0,
			result: null,
			error: null,
			bundledInto: null,
			included: true,
			...over,
		};
	}

	function specResult(spec: { content: string; sourceUrl?: string }): ImportResult {
		return {
			collections: [
				{
					name: "Petstore",
					description: "",
					variables: {},
					auth: { mode: "none" as const },
					preRequestScript: "",
					postRequestScript: "",
					children: [],
					requests: [],
					spec,
				},
			],
			environments: [],
			globals: {},
			meta: {
				format: "OpenAPI 3.0",
				requestCount: 0,
				folderCount: 0,
				environmentCount: 0,
				globalCount: 0,
				exampleCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
				unattachedFileParts: 0,
			},
		};
	}

	it("takes the document an entry is about to store, with the URL it came from", () => {
		expect(
			specCandidates([
				entry({
					result: specResult({
						content: PETSTORE,
						sourceUrl: "https://acme.dev/openapi.json",
					}),
				}),
			])
		).toEqual([
			{
				entryId: "e1",
				label: "openapi.json",
				content: PETSTORE,
				sourceUrl: "https://acme.dev/openapi.json",
			},
		]);
	});

	it("skips an entry that carries no spec, and one that did not parse", () => {
		const noSpec = specResult({ content: PETSTORE });
		delete noSpec.collections[0].spec;
		expect(
			specCandidates([
				entry({ id: "e1", result: noSpec }),
				entry({ id: "e2", result: null, error: "Unrecognised format" }),
			])
		).toEqual([]);
	});

	it("names a pasted document, which has neither a file name nor a URL", () => {
		expect(
			specCandidates([entry({ fileName: "", result: specResult({ content: PETSTORE }) })])[0]
				?.label
		).toBe("Pasted document");
	});
});
