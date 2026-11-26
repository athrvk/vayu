/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each body mode held, so a mode switch is not destructive. A request stores **one** body (a
 * discriminated union, `{"mode":"json","content":"..."}`), so JSON, text and GraphQL share
 * `request.body`: switching JSON to GraphQL handed the payload to `parseGraphQLBody`, which treats
 * a body without `query` as a raw query, and one keystroke later it was
 * `{"query":"{\"merchant\":\"mrc_8813\"}"}`, the original gone.
 *
 * - **Two buckets.** `json`, `text`, `jsonrpc`, `mcp` and `xml` are one raw string differing in
 *   highlighting: nothing here reads their text as a structure (JSON-RPC and MCP envelopes are
 *   completed engine-side, XML goes byte for byte), so text carries between them, and XML and JSON
 *   overwrite each other's text, the intended trade for one payload being reformatted. `graphql` is
 *   a structured envelope its panes parse, so it has its own. `form-data`, urlencoded and `binary`
 *   need none: they keep `formData`, `urlEncoded`, `binaryFile`, which the stored record never
 *   overwrites from another mode (`initialRequest` names each only in its own mode, #3665). An MCP
 *   body's `mcpTool` is request state (`RequestState.mcpTool`), not a draft.
 * - **Not persisted**: a request has one body, and payloads it never sends would land in exports
 *   and the engine's schema unread.
 * - **They live in `RequestBuilderProvider`, not `BodyPanel`**: Radix unmounts an inactive
 *   `TabsContent`, so a panel ref would lose the stashed JSON on a glance at Headers.
 * - **They belong to one request, and the type says so.** The provider does not remount per request
 *   (it resets its state during render on a new `initialRequest?.id`), so a ref there outlives its
 *   request: stash request A's JSON, pick JSON in B, and A's payload lands in B. Carrying
 *   `requestId` inside the drafts means no call can stash without naming whose body it is, and no
 *   second reset must keep step with the first.
 */

import type { BodyMode } from "../types";

/** Which drafts bucket a mode reads and writes, or null if it has no body. */
export type DraftKey = "raw" | "graphql";

export function draftKey(mode: BodyMode): DraftKey | null {
	if (
		mode === "json" ||
		mode === "text" ||
		mode === "jsonrpc" ||
		mode === "xml" ||
		mode === "mcp"
	) {
		return "raw";
	}
	if (mode === "graphql") return "graphql";
	// `none` sends nothing; form modes and `binary` keep their own state (`formData`, `urlEncoded`,
	// `binaryFile`), not a body string.
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
 * Stash the outgoing mode's body and restore the incoming one's. Two modes sharing a bucket keep
 * the body, so JSON to text does not clear the editor. `requestId` is the request edited *now*;
 * another request's drafts are dropped, not restored.
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

	// Another request's drafts are its payload, not drafts here.
	const own: BodyDrafts = drafts.requestId === requestId ? drafts : emptyDrafts(requestId);

	// Stash whatever the outgoing mode was holding, so returning to it restores.
	const next: BodyDrafts = fromKey ? { ...own, [fromKey]: currentBody } : { ...own };

	// A mode with no body of its own leaves `request.body` untouched: switching
	// to `none` and back should not have destroyed anything either.
	if (!toKey) return { body: currentBody, drafts: next };

	/*
	 * A same-bucket switch needs no branch: the stash just wrote `currentBody` under that key, so
	 * the read returns it.
	 */
	return { body: next[toKey] ?? "", drafts: next };
}

/**
 * The Variables pane's raw text, same reason and lifetime. The pane edits one *key* of the GraphQL
 * envelope, so the body cannot always hold it: `serializeGraphQLBody` drops text that is neither
 * JSON nor a resolvable template (deliberately, so the query keeps saving under an unclosed brace).
 * That makes the pane's text the only copy, and `GraphQLBody`'s `useState` the wrong home, as Radix
 * unmounts the inactive tab. Beside the mode drafts, not in them: it is one pane's text, not a
 * mode's body (that is the `graphql` bucket), and it names its request as `BodyDrafts` does.
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
