/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `{{token}}` affordances of a single-line field, expressed for Monaco.
 *
 * A `VariableInput` paints a strip of real DOM tokens over its `<input>`, so a
 * variable there can carry a colour, a tooltip and a popover trigger. A Monaco
 * editor has no DOM to hang them on - its text is drawn by the editor - so the
 * same three answers arrive as decorations (the colour), and as the app's own
 * tooltip and the shared `VariablePopover` drawn over the token's screen
 * rectangle (the reading and the editing). Issues #1220 and #1320.
 *
 * This module is the pure half: where the tokens are in a model, and which
 * class paints each state. The tooltip, the popover and the mouse handlers live
 * in `components/shared/EditorVariableTokens/`, which is where React is.
 *
 * **The states, and their classes, are `EditableVariable`'s.** The overlay
 * strip paints `text-destructive-text` / `text-muted-foreground` / `text-primary`
 * through Tailwind; Monaco's `inlineClassName` needs a plain global class, so
 * `index.css` declares one per state built from the same tokens. A reader who
 * sees the same `{{name}}` in a URL and in the body beneath it sees one colour.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import type { VariableTokenKind } from "./variable-token-kind";

/** One `{{name}}` found in a model, in Monaco's 1-based line/column space. */
export interface VariableTokenRange {
	name: string;
	lineNumber: number;
	/** 1-based column of the first `{`. */
	startColumn: number;
	/** 1-based column just past the final `}`. */
	endColumn: number;
}

/**
 * What a model can be read through, so the scan needs no Monaco instance.
 *
 * The two methods `ITextModel` already has, and the whole surface a test has to
 * stand up - the reason this file is testable in the node environment.
 */
export interface ScannableModel {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

/**
 * Every `{{name}}` in the model, line by line.
 *
 * Per line rather than over `getValue()`: Monaco addresses text as line and
 * column, so a whole-document scan would have to map offsets back to positions
 * itself - and `VARIABLE_PATTERN` does not cross a newline anyway (`[^{}]+`
 * matches one, but a token spanning lines is a mis-typed brace, not a variable
 * anything resolves).
 *
 * @param maxLines Stop after this many lines. A response body pasted into an
 * editor can be tens of thousands of lines, and painting the ones nobody has
 * scrolled to costs the same as painting the ones they have.
 */
export function variableTokenRanges(model: ScannableModel, maxLines = 5000): VariableTokenRange[] {
	const ranges: VariableTokenRange[] = [];
	const lineCount = Math.min(model.getLineCount(), maxLines);
	for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
		ranges.push(...variableTokensInLine(model.getLineContent(lineNumber), lineNumber));
	}
	return ranges;
}

/**
 * The tokens in one line. How `variableTokenRanges` walks a model, and what a
 * pointer needs: it is over one position, and scanning five thousand lines to
 * find out which token that is - on every mouse move - is work nobody reads.
 */
export function variableTokensInLine(line: string, lineNumber: number): VariableTokenRange[] {
	if (!line.includes("{{")) return [];
	const ranges: VariableTokenRange[] = [];
	for (const match of line.matchAll(VARIABLE_PATTERN)) {
		const name = match[1].trim();
		// `{{ }}` names nothing; painting it would be a colour with no meaning.
		if (!name) continue;
		ranges.push({
			name,
			lineNumber,
			startColumn: match.index + 1,
			endColumn: match.index + match[0].length + 1,
		});
	}
	return ranges;
}

/**
 * The class that paints each state, declared in `index.css`.
 *
 * Prefixed and spelled out rather than composed, so a search for the class in
 * the stylesheet finds the one that produced it.
 */
const TOKEN_CLASS: Record<string, string> = {
	resolved: "vayu-variable-token-resolved",
	empty: "vayu-variable-token-empty",
	undefined: "vayu-variable-token-undefined",
	"runtime-muted": "vayu-variable-token-runtime",
	"runtime-warning": "vayu-variable-token-warning",
};

/** Which `index.css` class paints a classified token. */
export function variableTokenClass(kind: VariableTokenKind): string {
	if (kind.state === "runtime") {
		return kind.tone === "warning"
			? TOKEN_CLASS["runtime-warning"]
			: TOKEN_CLASS["runtime-muted"];
	}
	return TOKEN_CLASS[kind.state];
}

/** Every class this module can produce - what a stylesheet guard checks. */
export const VARIABLE_TOKEN_CLASSES: readonly string[] = Object.values(TOKEN_CLASS);
