/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Insert a completion-table template at the cursor.
 *
 * Through Monaco's own snippet controller, not a text splice: the templates in
 * the engine's completion table are snippets (`${1:200}`, `$0`), and only the
 * controller turns those into the tab stops a user expects. Inserting the raw
 * string would put `${1:200}` in the script, and re-implementing tab stops here
 * would be a hand-rolled copy of a primitive Monaco already ships and fixes.
 *
 * It is the one place in the renderer that drives the controller, which is why
 * it takes the editor instance rather than living in a component: the two hosts
 * (the request Script panel and the collection Script tab) both hold one, and
 * neither should learn the action id.
 */

import type * as Monaco from "monaco-editor";

/** Names this app as the source of the edit in Monaco's undo stack. */
const SNIPPET_SOURCE = "vayu-script-snippets";

/**
 * Whether the snippet reached an editor. `false` means there was none to insert
 * into - the caller decides whether that is worth saying out loud.
 */
export function insertSnippetAtCursor(
	editor: Monaco.editor.IStandaloneCodeEditor | null | undefined,
	snippet: string
): boolean {
	if (!editor || !snippet) return false;
	/*
	 * Focus first. The click that asked for this landed on the snippets list, so
	 * the editor does not have focus, and a snippet expanded into an unfocused
	 * editor leaves the tab stops with nothing driving them.
	 */
	editor.focus();
	editor.trigger(SNIPPET_SOURCE, "editor.action.insertSnippet", { snippet });
	return true;
}
