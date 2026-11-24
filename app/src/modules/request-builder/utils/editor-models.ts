/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One Monaco model per request per editor (#3136). One `RequestBuilder` serves every request tab
 * and `BodyPanel` stays mounted once visited (#1718), so an editor outlives a request switch, and
 * `@monaco-editor/react` applies a changed `value` to the held model as an undoable edit: Ctrl+Z in
 * request B restored A's text through `onChange`, dirtying B and autosaving A's body into it. A
 * model per request (the `path` prop) makes the switch a `setModel`: each request keeps its undo
 * stack, cursor and scroll, and a matching value is no edit. **The pane is part of the path**: the
 * raw body and the GraphQL query share `request.body` but are different documents, and a shared
 * undo stack would offer the query as an undo step of the JSON payload.
 */

import type { MonacoApi } from "@/lib/monaco-api";
import { UNSAVED_AUTO_KEY } from "../context/auto-record-slot";

export type EditorPane =
	"body" | "graphql-query" | "graphql-variables" | "mcp-input-schema" | "mcp-output-schema";

const SCHEME = "inmemory";
const AUTHORITY = "request";

/** The model URI for one editor of one request. */
export function requestModelPath(requestId: string | null | undefined, pane: EditorPane): string {
	return `${SCHEME}://${AUTHORITY}/${encodeURIComponent(requestId ?? UNSAVED_AUTO_KEY)}/${pane}`;
}

/** The request id a model was filed under, or null for any other model. */
function requestIdOf(uri: { scheme: string; authority: string; path: string }): string | null {
	if (uri.scheme !== SCHEME || uri.authority !== AUTHORITY) return null;
	return uri.path.split("/")[1] ?? null;
}

/**
 * Dispose the request models whose request is not in `keep`. Idempotent, and safe on a model an
 * editor still shows: Monaco detaches it, and the editor takes the next request's model next
 * render. Other models (the response viewer's, a script's) are untouched. `keep` null disposes
 * every request model: the builder is going away.
 */
export function disposeRequestModels(monaco: MonacoApi, keep: ReadonlySet<string> | null): void {
	for (const model of monaco.editor.getModels()) {
		const id = requestIdOf(model.uri);
		if (id === null || keep?.has(id)) continue;
		model.dispose();
	}
}
