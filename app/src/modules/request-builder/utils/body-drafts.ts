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
 * **Two buckets, not eight.** `json`, `text`, `jsonrpc` and `xml` are the same
 * thing - a raw string body, differing only in syntax highlighting - so carrying
 * text between them is what you want. `graphql` is a structured envelope, and
 * carrying anything into or out of it is what caused the damage. `form-data`
 * and `x-www-form-urlencoded` do not use `body` at all; they have their own
 * arrays.
 *
 * `jsonrpc` and `xml` share the raw bucket rather than taking one of their own
 * because nothing on this side reads their text as a structure: JSON-RPC's
 * envelope is completed engine-side at wire time and an XML body is sent byte
 * for byte, so each pane holds one plain document that a `text` pane can show
 * unchanged. GraphQL got its own bucket for the opposite reason - its editor
 * state is structured, and the panes parse what they are given.
 *
 * Sharing the bucket does mean XML and JSON overwrite each other's text, which
 * is the intended trade: they are the same field, and a user switching between
 * them is reformatting one payload rather than keeping two.
 *
 * These drafts are deliberately *not* persisted: a request has one body, and
 * storing payloads it will never send would put them in exports and in the
 * engine's schema for no one to read.
 *
 * **They live in `RequestBuilderProvider`, not in `BodyPanel`.** The panel is
 * the obvious home and the wrong one: Radix unmounts an inactive `TabsContent`,
 * so stepping over to Headers and back tears `BodyPanel` down and takes a
 * panel-local ref with it. You would stash your JSON behind GraphQL, glance at
 * Headers, come back, and find the JSON gone. The provider survives that, which
 * is the whole reason it holds them.
 *
 * **They belong to one request, and the type says so.** What the provider does
 * *not* do is remount per request - it resets its state in an effect keyed on
 * `initialRequest?.id` - so a ref living there outlives the request that filled
 * it just as readily. Stash request A's JSON, switch to request B, pick JSON
 * there, and A's payload lands in B: the reported bug again, one step worse.
 * Carrying `requestId` inside the drafts rather than beside them means there is
 * no order of calls in which a caller can stash without saying whose body it
 * is, and no second reset to keep in step with the first.
 */

import type { BodyMode } from "../types";

/** Which drafts bucket a mode reads and writes, or null if it has no body. */
export type DraftKey = "raw" | "graphql";

export function draftKey(mode: BodyMode): DraftKey | null {
	if (mode === "json" || mode === "text" || mode === "jsonrpc" || mode === "xml") return "raw";
	if (mode === "graphql") return "graphql";
	// `none` sends nothing; the two form modes keep arrays, not a body string.
	return null;
}

export interface BodyDrafts extends Partial<Record<DraftKey, string>> {
	/** Whose body these are. Drafts do not survive a change of request. */
	requestId: string | null;
}

/** The empty drafts a panel starts from, before any mode has been left. */
export function emptyDrafts(requestId: string | null): BodyDrafts {
	return { requestId };
}

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
 *
 * `requestId` is the request being edited *now*. Drafts belonging to any other
 * request are dropped rather than restored.
 */
export function switchBody(
	from: BodyMode,
	to: BodyMode,
	currentBody: string,
	requestId: string | null,
	drafts: BodyDrafts
): BodySwitch {
	const fromKey = draftKey(from);
	const toKey = draftKey(to);

	// Someone else's drafts are not drafts, they are another request's payload.
	const own: BodyDrafts = drafts.requestId === requestId ? drafts : emptyDrafts(requestId);

	// Stash whatever the outgoing mode was holding, so returning to it restores.
	const next: BodyDrafts = fromKey ? { ...own, [fromKey]: currentBody } : { ...own };

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

/**
 * The Variables pane's raw text, for the same reason and with the same lifetime.
 *
 * The pane is a JSON editor over one *key* of the GraphQL envelope, so the body
 * cannot always hold what it shows: text that is neither JSON nor a resolvable
 * template is dropped by `serializeGraphQLBody` (deliberately - the query pane
 * must keep saving while the variables pane has an unclosed brace). That makes
 * the pane's own text the only copy, and `GraphQLBody`'s `useState` the wrong
 * place to keep it: Radix unmounts the inactive tab, so a glance at Headers
 * discarded a half-typed variables object exactly as it once discarded a stashed
 * JSON body.
 *
 * Carried beside the mode drafts rather than inside them because it is not a
 * *mode's* body - GraphQL's body is in the `graphql` bucket already. It is one
 * pane's in-progress text, and it names its own request for the reason
 * `BodyDrafts` does.
 */
export interface VariablesDraft {
	/** Whose pane this is. Drafts do not survive a change of request. */
	requestId: string | null;
	text: string;
}

/** The draft to restore, or null when it belongs to another request. */
export function ownVariablesDraft(
	draft: VariablesDraft | null,
	requestId: string | null
): string | null {
	return draft && draft.requestId === requestId ? draft.text : null;
}
