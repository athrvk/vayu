/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The script editor's warning on a bare `Intl` (#3129).
 *
 * The script runtime has no `Intl` global and installs none, and its
 * `toLocale*` methods ignore their locale and options, so a script that
 * formats with `Intl` throws a `ReferenceError` at send time, or formats the
 * wrong thing. The editor says so while the script is typed.
 *
 * **A warning marker, not a declaration.** The editor's TypeScript worker
 * resolves `Intl` against the stock `lib.es*.d.ts` and so reports nothing. The
 * marker is written under an owner of our own (see `INTL_MARKER_OWNER`).
 *
 * **Not an AST parse.** `findIntlReferences` is one pass of a small tokenizer
 * that knows exactly the things that make a regex over the raw text wrong:
 * strings, template text (but not its `${...}` expressions), comments and
 * regex literals. It reads an identifier as a whole word, so `MyIntl` and
 * `Intl2` are other names, and it reads the token before the word, so `obj.Intl`
 * and `x?.Intl` are property accesses and not the global.
 *
 * Two things stay unflagged because the name is then the user's own: an
 * object-literal key (`{ Intl: 1 }`), and every `Intl` in a script that
 * declares one (`const`, `let`, `var`, `function`, `class`). The declaring
 * script owns the name wherever it is used, so the whole script is left alone
 * rather than guessing at scopes. A parameter or a destructured binding is not
 * recognised as a declaration and is still flagged.
 */

import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "./monaco-api";

/** Markers replace per owner: `"javascript"` is the TypeScript worker's, and its next pass would erase ours. */
export const INTL_MARKER_OWNER = "vayu-script-intl";

export const INTL_MESSAGE =
	"No `Intl` in Vayu scripts - use `require('moment')` for dates, or format by hand; `toLocale*` methods ignore their options here.";

export interface IntlReference {
	/** Offset of the `I` of `Intl`. */
	start: number;
	/** One past the `l`. */
	end: number;
}

const INTL = "Intl";
const DECLARING_KEYWORDS = new Set(["const", "let", "var", "function", "class"]);
/** A `/` after one of these starts a regex literal; after any other word it divides. */
const REGEX_PRECEDING_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);
/** After one of these a `/` divides: the previous token ended an operand. */
const OPERAND_END_PUNCTUATION = new Set([")", "]"]);

const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const DIGIT = /[0-9]/;
const WHITESPACE = /\s/;

type TokenKind = "start" | "word" | "operand" | "punctuation";

interface Token {
	kind: TokenKind;
	text: string;
}

/** Every bare `Intl` reference in `text`, in source order. */
export function findIntlReferences(text: string): IntlReference[] {
	const found: IntlReference[] = [];
	let declared = false;
	// What an open `{` or `${` will be closed by, so a `}` can tell a template
	// expression's end (back to template text) from an ordinary block's.
	const openers: ("{" | "${")[] = [];
	let previous: Token = { kind: "start", text: "" };
	let i = 0;

	const finish = (token: Token, next: number) => {
		previous = token;
		i = next;
	};

	while (i < text.length) {
		const c = text[i];

		if (WHITESPACE.test(c)) {
			i++;
		} else if (c === "/" && text[i + 1] === "/") {
			i = endOfLine(text, i);
		} else if (c === "/" && text[i + 1] === "*") {
			i = endOfBlockComment(text, i);
		} else if (c === '"' || c === "'") {
			finish({ kind: "operand", text: c }, endOfString(text, i));
		} else if (c === "`") {
			const end = endOfTemplateText(text, i + 1);
			if (end.opensExpression) openers.push("${");
			finish({ kind: end.opensExpression ? "punctuation" : "operand", text: "`" }, end.next);
		} else if (c === "/" && regexAllowedAfter(previous)) {
			finish({ kind: "operand", text: "/" }, endOfRegex(text, i));
		} else if (IDENTIFIER_START.test(c)) {
			const end = endOfWord(text, i);
			const word = text.slice(i, end);
			if (word === INTL) {
				const role = roleOfIntl(text, end, previous);
				if (role === "declaration") declared = true;
				if (role === "reference") found.push({ start: i, end });
			}
			finish({ kind: "word", text: word }, end);
		} else if (DIGIT.test(c)) {
			finish({ kind: "operand", text: c }, endOfWord(text, i));
		} else if (c === "}" && openers.pop() === "${") {
			const end = endOfTemplateText(text, i + 1);
			if (end.opensExpression) openers.push("${");
			finish({ kind: end.opensExpression ? "punctuation" : "operand", text: "`" }, end.next);
		} else if (text.startsWith("...", i)) {
			finish({ kind: "punctuation", text: "..." }, i + 3);
		} else {
			if (c === "{") openers.push("{");
			finish({ kind: "punctuation", text: c }, i + 1);
		}
	}

	return declared ? [] : found;
}

type IntlRole = "reference" | "declaration" | "other";

function roleOfIntl(text: string, end: number, previous: Token): IntlRole {
	if (previous.text === ".") return "other";
	if (previous.kind === "word" && DECLARING_KEYWORDS.has(previous.text)) return "declaration";
	const isKey = (previous.text === "{" || previous.text === ",") && nextChar(text, end) === ":";
	return isKey ? "other" : "reference";
}

function regexAllowedAfter(previous: Token): boolean {
	if (previous.kind === "operand") return false;
	if (previous.kind === "word") return REGEX_PRECEDING_KEYWORDS.has(previous.text);
	return !OPERAND_END_PUNCTUATION.has(previous.text);
}

function nextChar(text: string, from: number): string {
	let i = from;
	while (i < text.length && WHITESPACE.test(text[i])) i++;
	return text[i] ?? "";
}

function endOfWord(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length && IDENTIFIER_PART.test(text[i])) i++;
	return i;
}

function endOfLine(text: string, from: number): number {
	const newline = text.indexOf("\n", from);
	return newline === -1 ? text.length : newline;
}

function endOfBlockComment(text: string, from: number): number {
	const close = text.indexOf("*/", from + 2);
	return close === -1 ? text.length : close + 2;
}

/** Past the closing quote; an unterminated literal ends at its line, as the engine's would error there. */
function endOfString(text: string, open: number): number {
	const quote = text[open];
	for (let i = open + 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === quote) return i + 1;
		else if (text[i] === "\n") return i;
	}
	return text.length;
}

/**
 * From just past a backtick or a `}` that closes a template expression: past
 * the closing backtick, or past the next `${`, which `opensExpression` reports
 * so the caller scans the expression as code.
 */
function endOfTemplateText(text: string, from: number): { next: number; opensExpression: boolean } {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "`") return { next: i + 1, opensExpression: false };
		else if (text[i] === "$" && text[i + 1] === "{")
			return { next: i + 2, opensExpression: true };
	}
	return { next: text.length, opensExpression: false };
}

/** Past the flags of the regex literal opening at `open`; an unterminated one ends at its line. */
function endOfRegex(text: string, open: number): number {
	let inClass = false;
	for (let i = open + 1; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "\n") return i;
		else if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return endOfFlags(text, i + 1);
	}
	return text.length;
}

function endOfFlags(text: string, from: number): number {
	let i = from;
	while (i < text.length && IDENTIFIER_PART.test(text[i])) i++;
	return i;
}

/**
 * Keep the editor's `Intl` warnings on the model the editor shows, until the
 * returned handle is disposed or the editor is. The warning follows the
 * model's text on every edit, moves with the editor to a new model, and is
 * cleared from the model it leaves.
 */
export function attachIntlDiagnostics(
	monaco: MonacoApi,
	editor: Monaco.editor.IStandaloneCodeEditor
): Monaco.IDisposable {
	let model: Monaco.editor.ITextModel | null = null;
	let contentListener: Monaco.IDisposable | null = null;
	// Whether markers are on `model`. A clean script stays unwritten; a script
	// with a reference is rewritten on every edit, because a whole-text replace
	// (the editor wrapper's external `value` update) collapses a marker's
	// decoration and Monaco re-syncs decorations only on a marker write.
	let written = false;

	const refresh = () => {
		if (!model || model.isDisposed()) return;
		const references = findIntlReferences(model.getValue());
		if (references.length === 0 && !written) return;
		written = references.length > 0;
		const shown = model;
		monaco.editor.setModelMarkers(
			shown,
			INTL_MARKER_OWNER,
			references.map((reference) => toMarker(shown, reference))
		);
	};

	const toMarker = (
		shown: Monaco.editor.ITextModel,
		reference: IntlReference
	): Monaco.editor.IMarkerData => {
		const start = shown.getPositionAt(reference.start);
		const end = shown.getPositionAt(reference.end);
		return {
			severity: monaco.MarkerSeverity.Warning,
			message: INTL_MESSAGE,
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
		};
	};

	const release = () => {
		contentListener?.dispose();
		contentListener = null;
		if (model && written && !model.isDisposed()) {
			monaco.editor.setModelMarkers(model, INTL_MARKER_OWNER, []);
		}
		model = null;
		written = false;
	};

	const follow = () => {
		release();
		model = editor.getModel();
		if (!model) return;
		contentListener = model.onDidChangeContent(refresh);
		refresh();
	};

	const listeners = [editor.onDidChangeModel(follow), editor.onDidDispose(() => dispose())];

	let disposed = false;
	function dispose() {
		if (disposed) return;
		disposed = true;
		for (const listener of listeners) listener.dispose();
		release();
	}

	follow();
	return { dispose };
}
