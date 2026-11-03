/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shell-aware tokenizer for pasted curl/wget commands.
 *
 * Splits a command string into argv, honoring the quoting rules that show up in
 * real-world "Copy as cURL" output from browsers and docs:
 *   - single quotes '...'      → literal (no escapes)
 *   - double quotes "..."      → \" and \\ escapes honored
 *   - ANSI-C $'...'            → \n \t \r \a \b \e \f \v \' \\ and the numeric forms
 *                                \xHH, \NNN (octal), \uHHHH, \UHHHHHHHH decoded
 *   - line continuations       → backslash + newline (bash) and ^ + newline (cmd)
 *   - Chrome "Copy as cURL (cmd)" → every ^ escape removed before tokenizing
 *   - leading prompt noise      → "$ " / "> " stripped per line
 *
 * `{{variables}}` are not special - they pass through as plain text.
 *
 * Throws on an unterminated quote so the caller can fall back to a no-op.
 */

export class UnterminatedQuoteError extends Error {
	constructor() {
		super("Unterminated quote in command");
		this.name = "UnterminatedQuoteError";
	}
}

const ANSI_C_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
};

/** Hex digits a `\x`, `\u` or `\U` escape reads at most (bash takes fewer, never more). */
const HEX_ESCAPE_WIDTH: Record<string, number> = { x: 2, u: 4, U: 8 };

const MAX_CODE_POINT = 0x10ffff;

// ignoreBOM keeps a leading U+FEFF instead of swallowing it as a byte-order mark.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type AnsiCEscape =
	{ text: string; byte?: undefined; next: number } | { byte: number; next: number };

/** Length of the UTF-8 sequence a lead byte opens; 1 for ASCII and for a byte that cannot lead. */
function utf8SequenceLength(lead: number): number {
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	if (lead >= 0xe0 && lead < 0xf0) return 3;
	if (lead >= 0xc2 && lead < 0xe0) return 2;
	return 1;
}

function tryDecodeUtf8(bytes: number[]): string | undefined {
	try {
		return UTF8.decode(Uint8Array.from(bytes));
	} catch {
		return undefined;
	}
}

/**
 * Decode a run of `\x` / octal bytes as UTF-8. A byte that does not start a
 * valid sequence is kept as its Latin-1 character rather than dropped or
 * turned into U+FFFD, so nothing the user pasted vanishes.
 */
function decodeBytes(bytes: number[]): string {
	let out = "";
	let at = 0;
	while (at < bytes.length) {
		const length = utf8SequenceLength(bytes[at]);
		const decoded = length > 1 ? tryDecodeUtf8(bytes.slice(at, at + length)) : undefined;
		if (decoded === undefined) {
			out += String.fromCharCode(bytes[at]);
			at++;
		} else {
			out += decoded;
			at += length;
		}
	}
	return out;
}

/** Read the escape whose letter sits at `at` (the character after the backslash). */
function readAnsiCEscape(src: string, at: number): AnsiCEscape {
	const letter = src[at];

	const simple = ANSI_C_ESCAPES[letter];
	if (simple !== undefined) return { text: simple, next: at + 1 };

	if (letter >= "0" && letter <= "7") {
		const octal = /^[0-7]{1,3}/.exec(src.slice(at, at + 3))![0];
		return { byte: parseInt(octal, 8) & 0xff, next: at + octal.length };
	}

	const width = HEX_ESCAPE_WIDTH[letter];
	if (width === undefined) return { text: letter, next: at + 1 };

	const digits = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(
		src.slice(at + 1, at + 1 + width)
	)?.[0];
	// bash leaves an escape with no digits, or beyond Unicode, as written.
	if (digits === undefined) return { text: `\\${letter}`, next: at + 1 };
	const next = at + 1 + digits.length;
	if (letter === "x") return { byte: parseInt(digits, 16), next };
	const codePoint = parseInt(digits, 16);
	if (codePoint > MAX_CODE_POINT) return { text: `\\${letter}${digits}`, next };
	// A \uD83D\uDE00 pair joins into one astral character by plain concatenation.
	return { text: String.fromCodePoint(codePoint), next };
}

/** Read the body of `$'...'` starting after the opening quote; `next` is past the closing quote. */
function readAnsiC(src: string, start: number): { value: string; next: number } {
	let value = "";
	let pendingBytes: number[] = [];
	const flushBytes = () => {
		value += decodeBytes(pendingBytes);
		pendingBytes = [];
	};

	let i = start;
	while (i < src.length && src[i] !== "'") {
		if (src[i] !== "\\" || i + 1 >= src.length) {
			flushBytes();
			value += src[i];
			i++;
			continue;
		}
		const escape = readAnsiCEscape(src, i + 1);
		if (escape.byte !== undefined) {
			pendingBytes.push(escape.byte);
		} else {
			flushBytes();
			value += escape.text;
		}
		i = escape.next;
	}
	flushBytes();
	if (i >= src.length) throw new UnterminatedQuoteError();
	return { value, next: i + 1 };
}

/** Strip a leading shell prompt (`$ ` or `> `) from each line. */
function stripPrompts(input: string): string {
	return input
		.split("\n")
		.map((line) => line.replace(/^\s*[$>]\s+/, ""))
		.join("\n");
}

/** Remove bash line continuations (backslash+newline). */
function joinBackslashContinuations(input: string): string {
	return input.replace(/\\\r?\n/g, " ");
}

/** Remove cmd line continuations (caret+newline) from a paste not recognized as a cmd copy. */
function joinCaretContinuations(input: string): string {
	return input.replace(/\^\r?\n/g, " ");
}

/**
 * An argument that opens with `^"` and a later one that closes with `^"` is
 * what Chrome's cmd copy writes for every quoted argument, and nothing a POSIX
 * command has a reason to contain. A `^` elsewhere (a regex in a body, a lone
 * `^"` inside quotes) does not qualify, so such a command is left alone.
 */
const CMD_QUOTED_ARGUMENT = /(?:^|\s)\^"[\s\S]*?\^"(?=\s|$)/;

/**
 * Undo cmd.exe's escaping: `^` makes the next character literal (`^"`, `^^`,
 * `^&`, `^%`, `^{`), and `^` before a newline continues the command. What is
 * left is the POSIX-style `"..."` text with `\"` for an embedded quote, which
 * the double-quote branch already reads.
 */
function unescapeCmdCarets(input: string): string {
	return input.replace(/\^(?:\r?\n|([\s\S])|$)/g, (_match, escaped?: string) => escaped ?? "");
}

export function tokenize(input: string): string[] {
	const prompted = stripPrompts(input);
	// A recognized cmd copy has its carets (continuations included) consumed
	// whole; `^^` before a newline is then a literal caret, not a continuation.
	const unescaped = CMD_QUOTED_ARGUMENT.test(prompted)
		? unescapeCmdCarets(prompted)
		: joinCaretContinuations(prompted);
	const src = joinBackslashContinuations(unescaped);
	const tokens: string[] = [];

	let current = "";
	let hasToken = false; // distinguishes "" (empty quoted arg) from no arg
	let i = 0;
	const n = src.length;

	while (i < n) {
		const ch = src[i];

		// Whitespace separates tokens (outside quotes).
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			i++;
			continue;
		}

		// ANSI-C quoting: $'...'
		if (ch === "$" && src[i + 1] === "'") {
			hasToken = true;
			const ansi = readAnsiC(src, i + 2);
			current += ansi.value;
			i = ansi.next;
			continue;
		}

		// Single quotes: literal, no escapes.
		if (ch === "'") {
			hasToken = true;
			i++;
			while (i < n && src[i] !== "'") {
				current += src[i];
				i++;
			}
			if (i >= n) throw new UnterminatedQuoteError();
			i++; // closing '
			continue;
		}

		// Double quotes: honor \" and \\ escapes.
		if (ch === '"') {
			hasToken = true;
			i++;
			while (i < n && src[i] !== '"') {
				if (src[i] === "\\" && (src[i + 1] === '"' || src[i + 1] === "\\")) {
					current += src[i + 1];
					i += 2;
				} else {
					current += src[i];
					i++;
				}
			}
			if (i >= n) throw new UnterminatedQuoteError();
			i++; // closing "
			continue;
		}

		// Backslash escape outside quotes.
		if (ch === "\\" && i + 1 < n) {
			hasToken = true;
			current += src[i + 1];
			i += 2;
			continue;
		}

		// Ordinary character.
		hasToken = true;
		current += ch;
		i++;
	}

	if (hasToken) tokens.push(current);
	return tokens;
}
