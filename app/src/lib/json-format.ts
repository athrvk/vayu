/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Indent a JSON document for reading, without ever reading its values.
 *
 * A `JSON.parse` / `JSON.stringify` round trip rewrites the document (issue
 * #2459): integer-like keys jump ahead of the others, a repeated key keeps only
 * its last value, and an integer past 2^53 loses digits. This is a single pass
 * over the text that copies every token through and decides only where the line
 * breaks go, the same job `lib/xml-format.ts` does for XML.
 *
 * Output matches `JSON.stringify(v, null, 2)` for a document that survives the
 * round trip: two-space indent, `"k": v`, and `{}` / `[]` for an empty
 * container.
 *
 * **Malformed input comes back unchanged**, by the same contract as the XML and
 * GraphQL formatters: a truncated or non-JSON body renders as what arrived. The
 * grammar is RFC 8259's and is checked as strictly as `JSON.parse` checks it -
 * a leading `+` or zero, a trailing comma, a raw control character in a string
 * and trailing text all leave the input as received. Only the four JSON
 * whitespace characters are skipped between tokens, and they are dropped rather
 * than kept, so the result has no leading or trailing whitespace.
 *
 * One leading U+FEFF is the exception (#3140): RFC 8259 section 8.1 lets a
 * parser ignore a BOM, and servers that emit one are common, so it is skipped
 * for scanning and left out of the result. A document that then fails to scan
 * still comes back whole, BOM included.
 */

/** Two spaces, matching the `JSON.stringify(value, null, 2)` beside it. */
const INDENT = "  ";

/**
 * Deeper than any real document. Output grows with depth times token count, so
 * the limit bounds the work a hostile body can ask for; what `JSON.stringify`
 * did with such a body was to throw and leave it unformatted, which this does
 * too.
 */
const MAX_DEPTH = 1024;

const BYTE_ORDER_MARK = 0xfeff;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/** What the next token may be. */
const Expect = {
	/** A value, and nothing else: the start of the document, or after `:` or `,`. */
	value: 0,
	/** A value or `]`: just after `[`. */
	valueOrEnd: 1,
	/** A key or `}`: just after `{`. */
	keyOrEnd: 2,
	/** A key: after `,` in an object. */
	key: 3,
	/** `:`, after a key. */
	colon: 4,
	/** `,` or the matching closer, after a value. */
	after: 5,
} as const;

interface Scan {
	readonly text: string;
	readonly out: string[];
	/** The open containers, innermost last, as the code of their opening character. */
	readonly stack: number[];
	state: number;
	/** The next character to read. */
	pos: number;
}

export function formatJson(text: string): string {
	const start = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
	const scan: Scan = { text, out: [], stack: [], state: Expect.value, pos: start };

	while (scan.pos < text.length) {
		const code = text.charCodeAt(scan.pos);
		if (isJsonWhitespace(code)) {
			scan.pos++;
			continue;
		}
		if (!step(scan, code)) return text;
	}

	const complete = scan.state === Expect.after && scan.stack.length === 0;
	return complete ? scan.out.join("") : text;
}

/** One non-whitespace character; false when the document cannot continue. */
function step(scan: Scan, code: number): boolean {
	switch (code) {
		case OPEN_BRACE:
		case OPEN_BRACKET:
			return open(scan, code);
		case CLOSE_BRACE:
		case CLOSE_BRACKET:
			return close(scan, code);
		case COMMA:
			return comma(scan);
		case COLON:
			return colon(scan);
		default:
			return token(scan, code);
	}
}

function open(scan: Scan, code: number): boolean {
	if (!startsValue(scan) || scan.stack.length >= MAX_DEPTH) return false;
	breakBeforeFirstMember(scan);
	scan.stack.push(code);
	scan.out.push(String.fromCharCode(code));
	scan.state = code === OPEN_BRACE ? Expect.keyOrEnd : Expect.valueOrEnd;
	scan.pos++;
	return true;
}

function close(scan: Scan, code: number): boolean {
	const braces = code === CLOSE_BRACE;
	const empty = scan.state === (braces ? Expect.keyOrEnd : Expect.valueOrEnd);
	if (!empty && scan.state !== Expect.after) return false;
	if (scan.stack[scan.stack.length - 1] !== (braces ? OPEN_BRACE : OPEN_BRACKET)) return false;

	scan.stack.pop();
	// An empty container stays `{}` / `[]`: its opener left the line unbroken.
	if (!empty) scan.out.push(lineBreak(scan.stack.length));
	scan.out.push(String.fromCharCode(code));
	scan.state = Expect.after;
	scan.pos++;
	return true;
}

function comma(scan: Scan): boolean {
	if (scan.state !== Expect.after || scan.stack.length === 0) return false;
	const inObject = scan.stack[scan.stack.length - 1] === OPEN_BRACE;
	scan.out.push(",", lineBreak(scan.stack.length));
	scan.state = inObject ? Expect.key : Expect.value;
	scan.pos++;
	return true;
}

function colon(scan: Scan): boolean {
	if (scan.state !== Expect.colon) return false;
	scan.out.push(": ");
	scan.state = Expect.value;
	scan.pos++;
	return true;
}

/** A string, number or literal: a member key where one is due, else a value. */
function token(scan: Scan, code: number): boolean {
	const isKey = scan.state === Expect.key || scan.state === Expect.keyOrEnd;
	if (isKey ? code !== QUOTE : !startsValue(scan)) return false;

	const end = scanScalar(scan.text, scan.pos, code);
	if (end < 0) return false;

	breakBeforeFirstMember(scan);
	scan.out.push(scan.text.slice(scan.pos, end));
	scan.state = isKey ? Expect.colon : Expect.after;
	scan.pos = end;
	return true;
}

function startsValue(scan: Scan): boolean {
	return scan.state === Expect.value || scan.state === Expect.valueOrEnd;
}

/** The first member of a container starts its line; later ones got theirs from the comma. */
function breakBeforeFirstMember(scan: Scan): void {
	if (scan.state === Expect.valueOrEnd || scan.state === Expect.keyOrEnd) {
		scan.out.push(lineBreak(scan.stack.length));
	}
}

const lineBreaks: string[] = [];

function lineBreak(depth: number): string {
	return (lineBreaks[depth] ??= "\n" + INDENT.repeat(depth));
}

/** Where the scalar starting at @p start ends, or -1 when it is not a JSON one. */
function scanScalar(text: string, start: number, code: number): number {
	if (code === QUOTE) return scanString(text, start);
	if (code === 0x2d || isDigit(code)) return scanNumber(text, start);
	return scanLiteral(text, start);
}

function scanString(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === QUOTE) return i + 1;
		if (code < 0x20) return -1;
		if (code !== BACKSLASH) {
			i++;
			continue;
		}
		i = skipEscape(text, i + 1);
		if (i < 0) return -1;
	}
	return -1;
}

/** Past the escape whose introducer (the character after its backslash) is at @p at, or -1. */
function skipEscape(text: string, at: number): number {
	const kind = text[at];
	if (kind !== undefined && '"\\/bfnrt'.includes(kind)) return at + 1;
	if (kind !== "u") return -1;
	for (let i = at + 1; i <= at + 4; i++) {
		if (!isHexDigit(text.charCodeAt(i))) return -1;
	}
	return at + 5;
}

/** `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, copied rather than evaluated. */
function scanNumber(text: string, start: number): number {
	let i = start;
	if (text[i] === "-") i++;
	if (text[i] === "0") {
		i++;
	} else {
		const afterInt = skipDigits(text, i);
		if (afterInt === i) return -1;
		i = afterInt;
	}
	if (text[i] === ".") {
		const afterFraction = skipDigits(text, i + 1);
		if (afterFraction === i + 1) return -1;
		i = afterFraction;
	}
	if (text[i] === "e" || text[i] === "E") {
		let exponent = i + 1;
		if (text[exponent] === "+" || text[exponent] === "-") exponent++;
		const afterExponent = skipDigits(text, exponent);
		if (afterExponent === exponent) return -1;
		i = afterExponent;
	}
	return i;
}

function skipDigits(text: string, from: number): number {
	let i = from;
	while (isDigit(text.charCodeAt(i))) i++;
	return i;
}

const LITERALS = ["true", "false", "null"] as const;

function scanLiteral(text: string, start: number): number {
	for (const literal of LITERALS) {
		if (text.startsWith(literal, start)) return start + literal.length;
	}
	return -1;
}

function isJsonWhitespace(code: number): boolean {
	return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
	return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}
