/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Insert-shape helper for the `pm.*` script completions.
 *
 * Most `pm.*` completions the engine emits are *snippets* that carry their own
 * argument list - `pm.variables.replaceIn(${1:"template"})`, not
 * `pm.variables.replaceIn`. That is the right shape when the call is being
 * written from nothing, and the wrong one when the call already exists:
 * completing the name in `pm.variables.rep|("$guid")` inserted a second,
 * placeholder-filled call and left `pm.variables.replaceIn("template")("$guid")`
 * behind.
 *
 * The replace-range is not what does this (it ends at the cursor - see
 * `script-completion-range.ts`); the snippet's own parens are. So when the text
 * immediately after the cursor already opens a call, insert the callee alone and
 * let the arguments the user has already typed stand. This is the same call
 * VS Code makes for `javascript.suggest.completeFunctionCalls`.
 */

/** A bare dotted path - what is left of a call snippet once its arguments go. */
const DOTTED_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * The callee path of a call snippet, when inserting it whole would duplicate a
 * call the line already has - otherwise `null`, meaning "insert as given".
 *
 * A `null` return covers every case worth leaving alone: a value completion
 * (no parens to duplicate), a cursor with no call after it, and a snippet whose
 * callee is itself a placeholder, which would insert `${1:…}` as literal text
 * the moment the snippet rule is dropped alongside the arguments.
 *
 * @param insertText the completion's `insertText`, snippet syntax included
 * @param lineSuffix line content from the cursor to the end of the line
 */
export function calleeOnlyInsertText(insertText: string, lineSuffix: string): string | null {
	// Immediately after the cursor, not merely somewhere to the right: a `(`
	// further along the line belongs to a different expression.
	if (!lineSuffix.startsWith("(")) return null;

	const open = insertText.indexOf("(");
	if (open === -1) return null;

	const callee = insertText.slice(0, open);
	return DOTTED_PATH.test(callee) ? callee : null;
}
