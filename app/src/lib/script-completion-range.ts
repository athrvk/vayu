/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Completion range helper for the `pm.*` script completions.
 *
 * The engine emits full dotted paths as `insertText` (e.g. "pm.test(...)",
 * "pm.response.code"). Monaco treats "." as a word separator, so the word under
 * the cursor right after "pm." is empty - replacing only that word leaves the
 * typed "pm." in place and the full-path insert appends after it, producing
 * "pm.pm.test". To insert correctly we must replace the entire dotted
 * identifier chain the user has already typed.
 *
 * See microsoft/monaco-editor#2136 (dotted member-access completions).
 */

/** Matches the dotted identifier chain ending at the cursor: `pm`, `pm.`, `pm.res`, `pm.response.`. */
const DOTTED_CHAIN = /[A-Za-z_$][\w$]*(?:\.[\w$]*)*$/;

/**
 * 1-based column where the completion replace-range should start: the beginning
 * of the dotted identifier chain immediately before the cursor. Returns the
 * cursor column itself (zero-width insert) when there is no such chain - e.g.
 * after `pm.expect(x).`, where the chain is broken by `)`, so member-relative
 * items like `to.equal` insert after the dot instead of swallowing it.
 *
 * @param linePrefix line content from column 1 up to (not including) the cursor
 * @param cursorColumn 1-based cursor column (Monaco position.column)
 */
export function completionReplaceStartColumn(linePrefix: string, cursorColumn: number): number {
	const match = linePrefix.match(DOTTED_CHAIN);
	return match ? cursorColumn - match[0].length : cursorColumn;
}
