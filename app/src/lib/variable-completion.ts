/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Is the caret inside an unclosed `{{`, and what has been typed so far?" One rule, two consumers:
 * the `VariableInput` overlay in the request builder and the Monaco completion provider for body
 * editors. One definition, because two copies of it (whether to show the list, and what to replace)
 * drift the moment either is touched.
 */

/** How the open marker is written, and how long it is. */
const OPEN = "{{";
const CLOSE = "}}";

export interface VariableCompletionContext {
	/** Characters typed after the `{{`, for filtering the list. */
	query: string;
	/** Index of the `{` that opens the marker, for computing a replace range. */
	openIndex: number;
}

/**
 * Returns null when the caret is not inside an open `{{`. "Inside" means a `{{` before the caret
 * and no `}}` between it and the caret, so a closed `{{name}}` sitting earlier in the line is not a
 * match, which stops the list reappearing after a variable is finished.
 */
export function variableCompletionContext(
	textBeforeCaret: string
): VariableCompletionContext | null {
	const openIndex = textBeforeCaret.lastIndexOf(OPEN);
	if (openIndex === -1) return null;

	const afterOpen = textBeforeCaret.slice(openIndex);
	if (afterOpen.includes(CLOSE)) return null;

	return { query: afterOpen.slice(OPEN.length), openIndex };
}
