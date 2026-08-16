/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Is this document one a collection is already bound to? (issue #680)
 *
 * Re-importing a bound spec used to make a second collection from scratch: none
 * of the first one's operation identities, none of its saved examples, none of
 * its coverage history - and no line anywhere saying the first one exists. The
 * two then diverge with nothing marking which is real. Sync is the documented
 * path for a document that moved, so an import that is really a re-import has to
 * be able to say so *before* it writes anything.
 *
 * Nothing here infers. `spec_documents` records where a document came from and
 * holds the bytes that were stored, and a collection's binding names the
 * document, so "is this already bound" is a lookup over two keys.
 *
 * **Both keys, because they catch different cases.**
 *
 * - `sourceUrl` catches the case Sync exists for - the same URL re-fetched,
 *   whose bytes have moved since. Comparing content cannot see that one at all:
 *   the bytes are precisely what changed.
 * - The bytes catch a document with no URL to match on - a file picked twice, or
 *   the same text pasted again.
 *
 * The bytes rather than a hash of them, for the reason `SpecSync` compares
 * bytes: the engine hashes what it stores, `GET /specs/:id` hands back exactly
 * those bytes, and a SHA-256 in the renderer would be a second implementation of
 * that rule with its own way of being wrong.
 */

import { hasSpecBinding, type Collection } from "@/types";
import type { BatchEntry } from "@/services/importers/batch";
import { entryLabel } from "@/services/importers/batch";

/** A collection that binds a document, before the document has been read. */
export interface BoundCollection {
	collectionId: string;
	collectionName: string;
	specId: string;
}

/** The same, once `GET /specs/:id` has answered for it. */
export interface BoundSpec extends BoundCollection {
	/** `null` for a document that came from a file or a paste. */
	sourceUrl: string | null;
	/** The stored bytes, verbatim - what a re-import is compared against. */
	content: string;
}

/** One document an import is about to store. */
export interface SpecCandidate {
	/** The batch entry it came from, so a match can name the file it is about. */
	entryId: string;
	/** What to call it on screen - file name, URL, or "Pasted document". */
	label: string;
	content: string;
	/** Set only for a URL-sourced import; a file or a paste has none. */
	sourceUrl?: string;
}

export interface SpecReimportMatch {
	entryId: string;
	label: string;
	collectionId: string;
	collectionName: string;
	/**
	 * Which key matched, because the two mean different things to the reader:
	 * `sourceUrl` is "the same document, possibly moved since" - the case Sync
	 * was built for - and `content` is "byte for byte the document that is
	 * already bound", which a sync would report as up to date.
	 */
	matchedBy: "sourceUrl" | "content";
}

/** Every collection with a binding, in the order the collections came in. */
export function boundCollections(collections: readonly Collection[]): BoundCollection[] {
	return collections
		.filter((c) => hasSpecBinding(c.openapi))
		.map((c) => ({
			collectionId: c.id,
			collectionName: c.name,
			// Narrowed by `hasSpecBinding`, which TypeScript cannot see through a
			// filter; the binding is what that predicate tests for.
			specId: c.openapi?.specId as string,
		}));
}

/**
 * The documents a batch is about to store, one per entry that carries one.
 *
 * Only the root of a parsed tree carries a spec (a tag sub-collection is part of
 * the same document, not one of its own), and the OpenAPI parsers produce a
 * single root - so this reads the first root that has one rather than inventing
 * a rule for a shape no parser makes.
 */
export function specCandidates(entries: readonly BatchEntry[]): SpecCandidate[] {
	return entries.flatMap((entry) => {
		const spec = entry.result?.collections.find((c) => c.spec)?.spec;
		if (!spec) return [];
		return [
			{
				entryId: entry.id,
				label: entryLabel(entry),
				content: spec.content,
				...(spec.sourceUrl ? { sourceUrl: spec.sourceUrl } : {}),
			},
		];
	});
}

/**
 * The bound collection each candidate is a re-import of, where there is one.
 *
 * At most one match per candidate: the question the dialog asks is "sync this
 * instead", and several collections may bind one document, so the first bound
 * collection wins - listing every collection that shares a document would ask
 * the user to choose between answers that are all the same document.
 *
 * URL before bytes, because a URL match is the more specific statement: it is
 * the same address, whether or not what it serves has changed since, and that is
 * exactly the case a re-import is trying to do the hard way.
 *
 * A URL is compared as written. A trailing slash, a different case in the path
 * or an added query is a different address, and deciding which differences do
 * not matter is the inference this lookup exists to avoid.
 */
export function matchBoundSpecs(
	candidates: readonly SpecCandidate[],
	bound: readonly BoundSpec[]
): SpecReimportMatch[] {
	return candidates.flatMap((candidate) => {
		const byUrl = candidate.sourceUrl
			? bound.find((b) => b.sourceUrl === candidate.sourceUrl)
			: undefined;
		const hit = byUrl ?? bound.find((b) => b.content === candidate.content);
		if (!hit) return [];
		return [
			{
				entryId: candidate.entryId,
				label: candidate.label,
				collectionId: hit.collectionId,
				collectionName: hit.collectionName,
				matchedBy: byUrl ? ("sourceUrl" as const) : ("content" as const),
			},
		];
	});
}
