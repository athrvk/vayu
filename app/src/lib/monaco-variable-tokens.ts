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
 * same three answers arrive as decorations (the colour), a hover provider (the
 * reading) and a click/chord that opens the shared `VariablePopover` over the
 * token's screen rectangle (the editing). Issue #1220.
 *
 * This module is the pure half: where the tokens are in a model, which class
 * paints each state, and what the hover says. The registration and the popover
 * live in `components/shared/EditorVariableTokens/`, which is where React is.
 *
 * **The states, and their classes, are `EditableVariable`'s.** The overlay
 * strip paints `text-destructive-text` / `text-muted-foreground` / `text-primary`
 * through Tailwind; Monaco's `inlineClassName` needs a plain global class, so
 * `index.css` declares one per state built from the same tokens. A reader who
 * sees the same `{{name}}` in a URL and in the body beneath it sees one colour.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import type { VariableTokenKind } from "./variable-token-kind";
import type { VariableOrigin } from "@/types";

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
 * The tokens in one line. What a hover needs - it is asked about a single
 * position, so scanning the document to answer would be work nobody reads.
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

/**
 * A value as the hover prints it, in the wording the tooltip already uses.
 *
 * A secret is the word `secret` and never dots and never the value: the popover
 * gates a reveal behind a deliberate click, and a hover that printed the string
 * on mouseover would walk straight around that gate (`EditableVariable`).
 */
function printedValue(value: string, secret: boolean | undefined): string {
	if (secret) return "_secret_";
	return value ? codeSpan(value) : "_empty_";
}

/**
 * A value inside a markdown code span, fenced rather than escaped.
 *
 * A backslash is literal inside a code span, so escaping the backticks does
 * nothing: `` \` `` still closes the span and the rest of the value spills into
 * the hover as markup. CommonMark's actual rule is the fence - a span opened
 * with N backticks runs to the next run of exactly N - so the fence is one
 * longer than the longest run the value contains, and a value that starts or
 * ends with a backtick takes a space of padding the renderer strips again.
 *
 * The values here are the user's own environment data: a shell command with
 * backticks, a Windows path full of backslashes, a JSON blob.
 */
function codeSpan(value: string): string {
	const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
	return `${fence}${pad}${value}${pad}${fence}`;
}

/** `environment - Staging`, or the bare scope where there is no name to give. */
function printedSource(scope: string, sourceName: string | undefined): string {
	return sourceName ? `${scope} - ${sourceName}` : scope;
}

/**
 * The hover's markdown, as `Hover.contents` takes it (Monaco 0.55 accepts
 * `IMarkdownString[]` only - no React, which is why the *edit* affordance is a
 * click and a chord rather than a button in here).
 *
 * It answers the same three questions as the tooltip over a single-line field,
 * from the same origins list: what does this resolve to, where did it come
 * from, and what else defines it. A token that answered them differently in two
 * places would be worse than one that answered both wrongly.
 */
export function variableHoverMarkdown(
	name: string,
	kind: VariableTokenKind,
	origins: VariableOrigin[],
	editHint?: string
): string[] {
	const heading = "`{{" + name + "}}`";

	if (kind.state === "runtime") {
		return [`${heading}\n\n${kind.description}\n\n_${kind.note}_`];
	}

	const boundRow = origins.find((o) => o.scope === "row");
	const shadowed = origins.filter((o) => o.scope !== "row" && !o.winner);

	const lines: string[] = [];
	if (boundRow) {
		// The row outranks every scope, so it is the answer whether or not one of
		// them also defines the name - the popover's own first branch.
		lines.push(`${heading}\n\n${printedValue(boundRow.value, false)}\n\n_Bound row_`);
	} else if (kind.state === "undefined") {
		lines.push(`${heading}\n\n_not defined_`);
	} else {
		const info = kind.info;
		lines.push(
			`${heading}\n\n${printedValue(info?.value ?? "", info?.secret)}\n\n_${printedSource(
				info?.scope ?? "global",
				info?.sourceName
			)}_`
		);
	}

	if (shadowed.length > 0) {
		const rows = shadowed.map(
			(o) =>
				`- ~~${printedSource(o.scope, o.sourceName)}~~${o.enabled ? "" : " (off)"}: ${printedValue(o.value, o.secret)}`
		);
		lines.push(["Also defined in:", ...rows].join("\n"));
	}

	if (editHint) lines.push(`_${editHint}_`);
	return lines;
}
