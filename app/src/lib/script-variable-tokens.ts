/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `{{token}}` affordances of a script editor - `javascript`'s entry in
 * `VARIABLE_TOKEN_MATCHERS` (`monaco-variable-tokens.ts`), and the reason a
 * script needs a matcher of its own rather than the body languages' single
 * `{{...}}` regex (issue #1220 script support).
 *
 * A script *names* a variable one of three ways, and only some of them are a
 * real read:
 *
 *  - `pm.<accessor>.get("name")` - a real read, of exactly one slice of the
 *    ladder. Which slice is `PM_ACCESSORS` in `referenced-variables.ts`
 *    (issue #1063) - the one table this module reads rather than duplicates,
 *    per that file's own warning about a second copy drifting.
 *  - `pm.variables.replaceIn("...{{name}}...")` - the one place `{{name}}`
 *    inside a script *is* interpolated, so every token in the template
 *    argument gets the same full treatment a body language's does.
 *  - a bare `{{name}}` anywhere else - never interpolated (D16,
 *    `docs/engine/scripting.md`), so it is muted and informational only.
 *
 * **Not an AST parse.** These are three fixed call shapes, so a regex per
 * accessor is intentionally sufficient and cheap on every keystroke - the
 * same call this module's callers already made for the body languages. What
 * a regex alone gets wrong is a name inside a comment or a string that merely
 * *looks* like a call, which is why this scans the whole script through a
 * small string/comment-aware mask first (`maskComments`) rather than
 * matching against the raw source.
 *
 * A known, accepted gap: a `//` inside a regex literal (`/https?:\/\//`) is
 * read as a comment starter, the same heuristic limit `referenced-variables.ts`
 * and every other regex-based scan in this codebase already accepts rather
 * than reaching for a real tokenizer to close it.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { PM_ACCESSORS } from "./referenced-variables";
import type { VariableScope } from "@/types";
import type { ScriptTokenHint } from "./variable-token-kind";
import type { ScannableModel, VariableTokenRange } from "./monaco-variable-tokens";

/** Stop after this many lines - the body matcher's own guard, for the same reason. */
const DEFAULT_MAX_LINES = 5000;

/**
 * The source, with every `//` and `/* *‍/` comment's characters replaced by
 * spaces - same length, same newlines, so every offset computed against it
 * still lands on the right line and column of the original.
 *
 * String content (`'`, `"`, `` ` ``) is left untouched and tracked instead, so
 * `"https://x"` is not misread as the start of a line comment.
 */
function maskComments(source: string): string {
	let out = "";
	let i = 0;
	const n = source.length;
	let inLineComment = false;
	let inBlockComment = false;
	let stringChar: string | null = null;

	while (i < n) {
		const c = source[i];
		const c2 = i + 1 < n ? source[i + 1] : "";

		if (inLineComment) {
			if (c === "\n") {
				inLineComment = false;
				out += c;
			} else {
				out += " ";
			}
			i++;
			continue;
		}

		if (inBlockComment) {
			if (c === "*" && c2 === "/") {
				out += "  ";
				i += 2;
				inBlockComment = false;
				continue;
			}
			out += c === "\n" ? "\n" : " ";
			i++;
			continue;
		}

		if (stringChar) {
			out += c;
			// An escaped character never closes the string (and never starts one) -
			// consumed as a pair so `\"` inside a double-quoted literal is not read
			// as its end.
			if (c === "\\" && i + 1 < n) {
				out += source[i + 1];
				i += 2;
				continue;
			}
			if (c === stringChar) stringChar = null;
			i++;
			continue;
		}

		if (c === "/" && c2 === "/") {
			inLineComment = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (c === "/" && c2 === "*") {
			inBlockComment = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			stringChar = c;
			out += c;
			i++;
			continue;
		}
		out += c;
		i++;
	}

	return out;
}

/** The 0-based offset just past a string's opening quote, one closing quote later - or -1. */
function findClosingQuote(text: string, start: number, quote: string): number {
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === quote) return i;
		// An unterminated literal on one line is a syntax error already; stop
		// rather than let the scan run into the rest of the script as "content".
		if (c === "\n") return -1;
	}
	return -1;
}

/** `off + 1` is Monaco's column for the character at 0-based offset `off` (see `monaco-variable-tokens.ts`). */
function positionAt(lineStarts: number[], offset: number): { lineNumber: number; column: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { lineNumber: lo + 1, column: offset - lineStarts[lo] + 1 };
}

/** The hint a read of this accessor implies - `undefined` for the merged read (`pm.variables`). */
function hintForAccessor(accessor: string): ScriptTokenHint | undefined {
	const read = PM_ACCESSORS[accessor];
	if (!read) return undefined;
	if (read.reads === "row") return { via: "row" };
	if (read.reads === "scope") return { via: "scope", scope: read.scope as VariableScope };
	return undefined; // "merged" - the ordinary ladder, same as a body-language token.
}

export function scriptVariableTokenRanges(
	model: ScannableModel,
	maxLines = DEFAULT_MAX_LINES
): VariableTokenRange[] {
	const lineCount = Math.min(model.getLineCount(), maxLines);
	const lines: string[] = [];
	const lineStarts: number[] = [0];
	let offset = 0;
	for (let i = 1; i <= lineCount; i++) {
		const content = model.getLineContent(i);
		lines.push(content);
		offset += content.length + 1; // +1 for the "\n" this module joins with.
		lineStarts.push(offset);
	}
	const masked = maskComments(lines.join("\n"));

	const ranges: VariableTokenRange[] = [];
	// Every accessor-argument and replaceIn-argument literal, so the bare scan
	// below does not also claim a `{{name}}` that is really inside one of them.
	const claimed: Array<[number, number]> = [];

	const pushRange = (name: string, start: number, end: number, scriptHint?: ScriptTokenHint) => {
		if (!name) return;
		const from = positionAt(lineStarts, start);
		const to = positionAt(lineStarts, end);
		// A span Monaco could not paint as one decoration - not a shape any of
		// these three matches produces in practice, but a malformed script (an
		// unterminated literal this scan already bailed on differently) should
		// never reach `variableTokenRanges`' one-range-per-line contract.
		if (from.lineNumber !== to.lineNumber) return;
		ranges.push({
			name,
			lineNumber: from.lineNumber,
			startColumn: from.column,
			endColumn: to.column,
			scriptHint,
		});
	};

	// 1. `pm.<accessor>.get("name")` - the whole literal is the name, scoped to
	// what that accessor reads.
	for (const accessor of Object.keys(PM_ACCESSORS)) {
		const prefix = new RegExp(`pm\\??\\.${accessor}\\??\\.get\\s*\\(\\s*(['"])`, "g");
		for (const match of masked.matchAll(prefix)) {
			const quote = match[1];
			const start = match.index + match[0].length;
			const end = findClosingQuote(masked, start, quote);
			if (end === -1) continue;
			claimed.push([start, end]);
			pushRange(masked.slice(start, end), start, end, hintForAccessor(accessor));
		}
	}

	// 2. `pm.variables.replaceIn("...{{name}}...")` - every `{{name}}` inside the
	// argument, with no hint: it reads the merged ladder, same as a body-language
	// token.
	const replaceInPrefix = /pm\??\.variables\??\.replaceIn\s*\(\s*(['"])/g;
	for (const match of masked.matchAll(replaceInPrefix)) {
		const quote = match[1];
		const start = match.index + match[0].length;
		const end = findClosingQuote(masked, start, quote);
		if (end === -1) continue;
		claimed.push([start, end]);
		const argument = masked.slice(start, end);
		for (const inner of argument.matchAll(VARIABLE_PATTERN)) {
			const name = inner[1].trim();
			if (!name) continue;
			const tokenStart = start + inner.index;
			pushRange(name, tokenStart, tokenStart + inner[0].length, undefined);
		}
	}

	// 3. A bare `{{name}}` anywhere else - muted and informational (issue #1220).
	for (const match of masked.matchAll(VARIABLE_PATTERN)) {
		const name = match[1].trim();
		if (!name) continue;
		const start = match.index;
		if (claimed.some(([from, to]) => start >= from && start < to)) continue;
		pushRange(name, start, start + match[0].length, { via: "bare" });
	}

	return ranges;
}
