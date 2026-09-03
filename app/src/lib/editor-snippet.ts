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
 * **The controller is reached by contribution, never by action id.** This first
 * shipped as `editor.trigger(source, "editor.action.insertSnippet", { snippet })`
 * and did nothing at all: that command belongs to VS Code's *workbench*, not to
 * the standalone editor this app embeds - `monaco-editor` registers
 * `SnippetController2` as the `snippetController2` *contribution* and no action
 * of that name. `trigger` looks its argument up in the editor's action map and
 * returns silently when there is no match, so a wrong id is not an error
 * anywhere: the click simply did nothing. `getContribution` is the door that
 * reports its own absence (`null`), which is why it is the one used here.
 *
 * It is the one place in the renderer that drives the controller, which is why
 * it takes the editor instance rather than living in a component: the two hosts
 * (the request Script panel and the collection Script tab) both hold one, and
 * neither should learn how a snippet is inserted.
 */

import type * as Monaco from "monaco-editor";

/**
 * The contribution id `monaco-editor` registers `SnippetController2` under
 * (`SnippetController2.ID`). Lazily instantiated, which `getContribution`
 * handles: it builds the contribution on first ask.
 */
const SNIPPET_CONTROLLER = "snippetController2";

/**
 * Where a template ended up, so the caller can say so - the same shape and the
 * same reason as the GraphQL explorer's `InsertPlacement` (`insert-skeleton.ts`):
 * an insertion the user cannot see is one they cannot trust landed.
 */
export type SnippetPlacement = "cursor" | "end-of-script";

export interface SnippetInsertion {
	placement: SnippetPlacement;
}

/** The half of `SnippetController2` this module uses. */
interface SnippetInserter extends Monaco.editor.IEditorContribution {
	insert(template: string): void;
}

/**
 * What a template needs in front of it to land as its own statement on the line
 * the caret is on.
 *
 * Every template in the table is one or more whole statements, and the caret is
 * wherever the author last left it - which this click cannot move, since it
 * landed on a list below the editor. Two things follow, both measured against
 * the real editor rather than reasoned about:
 *
 * - **The column is not a landing site.** A caret parked inside
 *   `const t = Date.now();` cuts it wherever it happens to sit, and inserting
 *   there - with or without a newline around it - leaves `const t = D` above
 *   the template and `ate.now();` below it. So the template goes to the *end of
 *   that line*, never into it, and a statement is never split.
 * - **A blank line is where it belongs already**, indentation included: landing
 *   at the end of `\t\t` puts the template after the tabs, which is what the
 *   author was lining up. Only a line with code on it needs a break in front.
 */
export function snippetLanding(lineText: string): { before: string } {
	return { before: lineText.trim() === "" ? "" : "\n" };
}

/**
 * Where the snippet landed, or `null` when it could not land at all - there was
 * no editor, no template, or no controller on it. The caller says so out loud;
 * this only reports.
 */
export function insertSnippetAtCursor(
	editor: Monaco.editor.IStandaloneCodeEditor | null | undefined,
	snippet: string
): SnippetInsertion | null {
	if (!editor || !snippet) return null;

	const controller = editor.getContribution<SnippetInserter>(SNIPPET_CONTROLLER);
	if (!controller || typeof controller.insert !== "function") return null;

	/*
	 * Focus first. The click that asked for this landed on the snippets list, so
	 * the editor does not have focus, and a snippet expanded into an unfocused
	 * editor leaves the tab stops with nothing driving them.
	 */
	editor.focus();

	/*
	 * Where it lands, decided here rather than left to the controller.
	 *
	 * `SnippetSession` builds its edit from `editor.getSelections()`, so a
	 * selection is the range the template *replaces*. That is right when the
	 * snippet was accepted from the completion popup - the selection is the
	 * prefix being completed - and wrong from a list: clicking a row would
	 * delete whatever the author had highlighted, with no way to see it coming.
	 * So a selection is collapsed to its end first: the click adds code, never
	 * removes any.
	 */
	const model = editor.getModel();
	const selection = editor.getSelection();
	const position = selection ? selection.getEndPosition() : editor.getPosition();
	if (!model || !position) {
		controller.insert(snippet);
		return { placement: "cursor" };
	}

	/*
	 * A caret at the very start of a script nobody has clicked into is not a
	 * decision, it is Monaco's default - and dropping a template above code the
	 * author has already written is the least likely thing they meant. The
	 * GraphQL explorer answers the same question the same way: a cursor outside
	 * every selection set does not become a splice point at offset 0, the
	 * insertion is appended to the end of the document as a new operation
	 * (`insert-skeleton.ts`, placement `new-operation`). This is that rule in
	 * a language with no selection sets: no caret of the author's own, so the
	 * template goes after what is already there.
	 */
	const untouched = position.lineNumber === 1 && position.column === 1;
	const line =
		untouched && model.getValueLength() > 0 ? model.getLineCount() : position.lineNumber;

	const landing = snippetLanding(model.getLineContent(line));
	editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
	controller.insert(`${landing.before}${snippet}`);
	return { placement: line === position.lineNumber ? "cursor" : "end-of-script" };
}
