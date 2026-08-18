/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading requests out of a parsed import without depending on where the parser
 * filed them (issue #710).
 *
 * Every OpenAPI test that asserts something about *one* request - its headers,
 * its body, the value on a query row - used to reach for
 * `collections[0].requests[0]`, which encoded the grouping rule into ~50
 * assertions that are not about grouping at all. The moment untagged operations
 * gained a path-derived folder, all of them read `undefined`.
 *
 * So: walk the tree. A test that means "the request this one-operation fixture
 * produced" now says exactly that, and stays true whichever folder holds it.
 * Grouping itself is asserted where it belongs, in `openapi-folders.test.ts`.
 */

import type { CollectionDraft, ImportResult, RequestDraft } from "@/services/importers/types";

/** Every request in a draft tree, root-level first, then each folder's, in order. */
export function allRequests(collections: CollectionDraft[]): RequestDraft[] {
	return collections.flatMap((c) => [...c.requests, ...allRequests(c.children)]);
}

/** Every request a parsed import produced, whichever folder each one landed in. */
export function requestsOf(result: ImportResult): RequestDraft[] {
	return allRequests(result.collections);
}

/**
 * The single request a one-operation fixture produced, wherever grouping put it.
 *
 * Throws rather than picking the first of several: a fixture that grew a second
 * operation would otherwise silently move the assertion onto a different
 * request.
 */
export function soleRequest(result: ImportResult): RequestDraft {
	const found = allRequests(result.collections);
	if (found.length !== 1) {
		throw new Error(`expected exactly one imported request, found ${found.length}`);
	}
	return found[0];
}

/** The request named @p name, wherever grouping put it. */
export function requestNamed(result: ImportResult, name: string): RequestDraft {
	const found = allRequests(result.collections).filter((r) => r.name === name);
	if (found.length !== 1) {
		throw new Error(`expected exactly one request named "${name}", found ${found.length}`);
	}
	return found[0];
}
