/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Switching body mode used to reinterpret the same string, and it was
 * destructive.
 *
 * A request stores **one** body - the stored shape is a discriminated union,
 * `{"mode":"json","content":"..."}` - so JSON, text and GraphQL all shared
 * `request.body`. Switching from JSON to GraphQL therefore handed your payload
 * to `parseGraphQLBody`, which finds no `query` key and falls back to treating
 * the whole thing as a raw query string. One keystroke later the body was
 * `{"query":"{\"merchant\":\"mrc_8813\"}"}` and switching back showed *that* in
 * the JSON editor. The original payload was gone.
 *
 * **Two buckets, not six.** `json` and `text` are the same thing - a raw string
 * body, differing only in syntax highlighting - so carrying text between them
 * is what you want. `graphql` is a structured envelope, and carrying anything
 * into or out of it is what caused the damage. `form-data` and
 * `x-www-form-urlencoded` do not use `body` at all; they have their own arrays.
 *
 * These drafts live for as long as the panel does. They are deliberately *not*
 * persisted: a request has one body, and storing payloads it will never send
 * would put them in exports and in the engine's schema for no one to read.
 */

import type { BodyMode } from "../../../../types";

/** Which drafts bucket a mode reads and writes, or null if it has no body. */
export type DraftKey = "raw" | "graphql";

export function draftKey(mode: BodyMode): DraftKey | null {
	if (mode === "json" || mode === "text") return "raw";
	if (mode === "graphql") return "graphql";
	// `none` sends nothing; the two form modes keep arrays, not a body string.
	return null;
}

export type BodyDrafts = Partial<Record<DraftKey, string>>;

export interface BodySwitch {
	/** The body the new mode should show. */
	body: string;
	/** Drafts with the outgoing mode's text stashed. */
	drafts: BodyDrafts;
}

/**
 * Stash the outgoing mode's body and restore the incoming one's.
 *
 * Returns the same body when both modes share a bucket, so JSON to text does
 * not clear the editor - the string is the same string, and only the
 * highlighting changes.
 */
export function switchBody(
	from: BodyMode,
	to: BodyMode,
	currentBody: string,
	drafts: BodyDrafts
): BodySwitch {
	const fromKey = draftKey(from);
	const toKey = draftKey(to);

	// Stash whatever the outgoing mode was holding, so returning to it restores.
	const next: BodyDrafts = fromKey ? { ...drafts, [fromKey]: currentBody } : { ...drafts };

	// A mode with no body of its own leaves `request.body` untouched: switching
	// to `none` and back should not have destroyed anything either.
	if (!toKey) return { body: currentBody, drafts: next };

	/*
	 * Same bucket carries over without a branch for it: the stash above just
	 * wrote `currentBody` under that key, so reading it back returns the same
	 * string. An explicit `if (fromKey === toKey)` was here first and a mutation
	 * run deleted it with every test still green - redundant code with a
	 * confident comment, which is the shape worth noticing.
	 */
	return { body: next[toKey] ?? "", drafts: next };
}
