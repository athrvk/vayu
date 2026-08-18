/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How an OpenAPI import decides what goes in which folder (issue #710).
 *
 * Grouping by an operation's first tag is right up until a document declares no
 * operation tags at all - Stripe's official spec is 568 operations with root
 * `tags:` that **no operation references**, so tag grouping alone dropped the
 * whole API into one flat list of 568 requests. The fallback groups by the first
 * meaningful path segment, which is what the vendor's own docs are organized by.
 *
 * Both parsers are driven here rather than once each: the routing lives in
 * `OperationFolders` precisely so there is one rule, and a test per parser is
 * how the second copy would have gone unnoticed.
 *
 * Mutation check: make `place()` push every untagged request onto the root and
 * the three tagging shapes below fail; drop the version-prefix skip and the
 * Stripe-shaped case files everything under `v1`.
 */

import { describe, it, expect } from "vitest";
import { OpenApiV3Parser } from "./openapi-v3";
import { OpenApiV2Parser } from "./openapi-v2";
import { pathFolderName } from "./openapi-shared";
import type { CollectionDraft, ImportResult } from "./types";

const opts = { importEnvironments: true, importScripts: true };

/** An OpenAPI 3 document whose operations are @p operations, keyed by path. */
function v3(
	paths: Record<string, Record<string, unknown>>,
	tags?: unknown[]
): Record<string, unknown> {
	return {
		openapi: "3.0.0",
		info: { title: "API" },
		...(tags ? { tags } : {}),
		paths: Object.fromEntries(
			Object.entries(paths).map(([path, op]) => [path, { get: { summary: path, ...op } }])
		),
	};
}

/** The same document as a Swagger 2.0 one, so both parsers answer the same question. */
function v2(
	paths: Record<string, Record<string, unknown>>,
	tags?: unknown[]
): Record<string, unknown> {
	return { ...v3(paths, tags), swagger: "2.0", openapi: undefined };
}

function parseV3(document: Record<string, unknown>): ImportResult {
	return new OpenApiV3Parser().parse(document, JSON.stringify(document), opts);
}

function parseV2(document: Record<string, unknown>): ImportResult {
	return new OpenApiV2Parser().parse(document, JSON.stringify(document), opts);
}

/** Folder name → the requests it holds, for one parsed import. */
function foldered(result: ImportResult): Record<string, string[]> {
	const root: CollectionDraft = result.collections[0];
	return Object.fromEntries(root.children.map((c) => [c.name, c.requests.map((r) => r.name)]));
}

describe("folders for an untagged spec", () => {
	// (a) no tags anywhere - the shape a hand-written or generated spec often has.
	const untagged = {
		"/v1/account_links": {},
		"/v1/checkout/sessions": {},
		"/v1/checkout/sessions/{session}": {},
	};

	it("groups by the first meaningful path segment, in both parsers", () => {
		for (const result of [parseV3(v3(untagged)), parseV2(v2(untagged))]) {
			expect(foldered(result)).toEqual({
				account_links: ["/v1/account_links"],
				checkout: ["/v1/checkout/sessions", "/v1/checkout/sessions/{session}"],
			});
			// Nothing left flat, and the preview's count is what the tree holds.
			expect(result.collections[0].requests).toEqual([]);
			expect(result.meta.folderCount).toBe(2);
		}
	});

	it("says the folders came from paths, so the tree is not a surprise", () => {
		expect(parseV3(v3(untagged)).meta.folderStrategy).toBe("paths");
		expect(parseV2(v2(untagged)).meta.folderStrategy).toBe("paths");
	});

	// (b) the Stripe shape: root tags declared, referenced by no operation.
	it("ignores root tags no operation references", () => {
		const document = v3(untagged, [
			{ name: "billing", description: "Billing APIs", "x-kind": "api-group" },
			{ name: "core", "x-kind": "api-group" },
		]);
		// Matching those group names onto paths is guesswork the importer refuses
		// (a recorded non-goal), so they contribute no folder at all.
		expect(Object.keys(foldered(parseV3(document)))).toEqual(["account_links", "checkout"]);
	});
});

describe("folders for a tagged spec", () => {
	const tagged = {
		"/pets": { tags: ["pets"] },
		"/pets/{id}": { tags: ["pets", "admin"] },
	};

	it("keeps tag grouping untouched, with the declared description", () => {
		const result = parseV3(v3(tagged, [{ name: "pets", description: "Pet ops" }]));
		expect(foldered(result)).toEqual({ pets: ["/pets", "/pets/{id}"] });
		expect(result.collections[0].children[0].description).toBe("Pet ops");
		// Only the first tag groups an operation - `admin` is not a folder.
		expect(result.meta.folderStrategy).toBe("tags");
	});

	// (c) mixed: a partially tagged document gets both rules, per operation.
	it("falls back per operation, so a partly tagged spec gets both", () => {
		const result = parseV3(v3({ "/pets": { tags: ["pets"] }, "/v2/orders/{id}": {} }));
		expect(foldered(result)).toEqual({ pets: ["/pets"], orders: ["/v2/orders/{id}"] });
		expect(result.meta.folderStrategy).toBe("mixed");
	});

	it("merges a path folder and a tag of the same name, keeping the description", () => {
		// The path fallback can land on a name a tag also uses. One folder holds
		// both rather than two folders sharing a name, and the tag's description
		// still describes what is in it.
		const result = parseV3(
			v3({ "/orders": {}, "/legacy": { tags: ["orders"] } }, [
				{ name: "orders", description: "Order ops" },
			])
		);
		expect(foldered(result)).toEqual({ orders: ["/orders", "/legacy"] });
		expect(result.collections[0].children[0].description).toBe("Order ops");
	});
});

describe("a path that names no resource", () => {
	it("leaves the request on the root rather than inventing a folder", () => {
		const result = parseV3(v3({ "/": {}, "/v1": {}, "/api/{id}": {} }));
		expect(result.collections[0].children).toEqual([]);
		expect(result.collections[0].requests.map((r) => r.name)).toEqual([
			"/",
			"/v1",
			"/api/{id}",
		]);
		// No folders means no rule to explain, so the preview says nothing.
		expect(result.meta.folderStrategy).toBeUndefined();
		expect(result.meta.folderCount).toBe(0);
	});
});

describe("pathFolderName", () => {
	it("steps over version, api and template segments to the first resource", () => {
		expect(pathFolderName("/v1/account_links")).toBe("account_links");
		expect(pathFolderName("/api/v2/{tenant}/orders")).toBe("orders");
		expect(pathFolderName("/V1.1/users")).toBe("users");
		// Only leading segments are stepped over - a resource named `api` deeper in
		// the path is still what the operation is about.
		expect(pathFolderName("/users/{id}/api")).toBe("users");
	});

	it("returns undefined when the path names nothing to group by", () => {
		expect(pathFolderName("/")).toBeUndefined();
		expect(pathFolderName("/v1")).toBeUndefined();
		expect(pathFolderName("/api/{id}")).toBeUndefined();
	});
});
