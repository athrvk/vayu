/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Indent an XML document for reading.
 *
 * The response viewer's Pretty toggle pretty-printed **JSON only**, so Pretty
 * and Raw were byte-identical for every XML response - the one thing the toggle
 * exists to do, not done, for the SOAP and legacy-enterprise APIs the `xml` body
 * mode (issue #580) is for.
 *
 * **A string walk, not a parser.** `DOMParser` is available in the renderer and
 * would be the obvious tool; it is not available in the `node` test environment
 * this repo defaults to, so the rule would be the one thing untestable. Prettier
 * core ships no XML parser either. A tag-depth walk needs neither and is exact
 * about the only thing being asked of it: where the line breaks go.
 *
 * **Malformed input comes back unchanged**, the same contract
 * `lib/graphql/format.ts` has - a body mid-edit, or one still holding an
 * unresolved `{{token}}`, must render as what the user typed rather than as a
 * guess at what they meant. "Malformed" here means the walk cannot trust its own
 * depth: an unterminated tag, a close tag that does not match the open one, or
 * anything left open at the end.
 *
 * **Mixed content is emitted verbatim.** In `<p>hello <b>x</b> world</p>` the
 * spaces around `<b>` are part of the text, and an indenter that put each child
 * on its own line would be editing the document rather than formatting it. An
 * element holding both text and element children is therefore copied through
 * from the source, inner formatting and all.
 */

/** Two spaces, matching the `JSON.stringify(value, null, 2)` beside it. */
const INDENT = "  ";

type TokenKind =
	/** `<a>` */
	| "open"
	/** `</a>` */
	| "close"
	/** `<a/>`, and everything that cannot contain children: comments, CDATA,
	 *  the XML declaration, a processing instruction, a doctype. */
	| "leaf"
	/** Anything between tags. */
	| "text";

interface Token {
	kind: TokenKind;
	/** Element name, for the open/close pairing. Empty for `leaf` and `text`. */
	name: string;
	/** Offset of the token's first character in the source. */
	start: number;
	/** Offset one past the token's last character. */
	end: number;
}

/** The element name at `start`, which sits on the `<` or on the `/` after it. */
function readName(source: string, start: number): string {
	let i = start;
	while (i < source.length && !/[\s/>]/.test(source[i])) i += 1;
	return source.slice(start, i);
}

/**
 * The offset one past this tag's `>`.
 *
 * Quote-aware, because an attribute value may legitimately contain `>`
 * (`<a href="x?a=1&gt;2">` is not the only shape - an unescaped `>` in an
 * attribute is well-formed XML). Scanning for the next `>` would end the tag
 * inside the attribute and take the rest of the document with it.
 *
 * -1 when the tag is never closed, which the caller reads as malformed.
 */
function endOfTag(source: string, start: number): number {
	let quote = "";
	for (let i = start; i < source.length; i += 1) {
		const c = source[i];
		if (quote) {
			if (c === quote) quote = "";
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === ">") return i + 1;
	}
	return -1;
}

/** The offset one past `terminator`, or -1 if the source never closes it. */
function endOfSpan(source: string, start: number, terminator: string): number {
	const at = source.indexOf(terminator, start);
	return at === -1 ? -1 : at + terminator.length;
}

/** Every token in order, or null if the source is not something we can walk. */
function tokenize(source: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;

	while (i < source.length) {
		if (source[i] !== "<") {
			const next = source.indexOf("<", i);
			const end = next === -1 ? source.length : next;
			tokens.push({ kind: "text", name: "", start: i, end });
			i = end;
			continue;
		}

		// The five shapes that cannot contain children, each ended by its own
		// terminator rather than by the next `>`: a comment or a CDATA section may
		// hold any number of them.
		let end: number;
		if (source.startsWith("<!--", i)) end = endOfSpan(source, i + 4, "-->");
		else if (source.startsWith("<![CDATA[", i)) end = endOfSpan(source, i + 9, "]]>");
		else if (source.startsWith("<?", i)) end = endOfSpan(source, i + 2, "?>");
		else end = endOfTag(source, i);

		if (end === -1) return null;

		const raw = source.slice(i, end);
		if (raw.startsWith("<!") || raw.startsWith("<?")) {
			tokens.push({ kind: "leaf", name: "", start: i, end });
		} else if (raw.startsWith("</")) {
			tokens.push({ kind: "close", name: readName(source, i + 2), start: i, end });
		} else if (raw.endsWith("/>")) {
			tokens.push({ kind: "leaf", name: "", start: i, end });
		} else {
			tokens.push({ kind: "open", name: readName(source, i + 1), start: i, end });
		}
		i = end;
	}

	return tokens;
}

/**
 * For every `open` token, the index of its matching `close`.
 *
 * Null when the two do not pair up - a close naming a different element than
 * the one that is open, a close with nothing open, or an element still open at
 * the end. Each of those means the depth this whole function computes would be
 * a guess, so the caller returns the source untouched instead.
 */
function pairTags(tokens: Token[]): Map<number, number> | null {
	const partner = new Map<number, number>();
	const open: number[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token.kind === "open") {
			open.push(i);
		} else if (token.kind === "close") {
			const from = open.pop();
			if (from === undefined || tokens[from].name !== token.name) return null;
			partner.set(from, i);
		}
	}

	return open.length === 0 ? partner : null;
}

/**
 * Whether an element's children are text and elements both - see the header.
 *
 * Its *direct* children: a nested element is stepped over rather than walked
 * into, because text deeper down belongs to that element and says nothing about
 * this one. Counting descendants instead would call every ancestor of a leaf
 * value mixed - which is to say, almost every document - and the indenter would
 * emit the whole tree on one line.
 */
function isMixed(
	tokens: Token[],
	source: string,
	from: number,
	to: number,
	partner: Map<number, number>
): boolean {
	let hasText = false;
	let hasElement = false;
	let i = from + 1;

	while (i < to) {
		const token = tokens[i];
		if (token.kind === "text") {
			if (source.slice(token.start, token.end).trim() !== "") hasText = true;
			i += 1;
			continue;
		}
		hasElement = true;
		i = token.kind === "open" ? (partner.get(i) ?? i) + 1 : i + 1;
	}

	return hasText && hasElement;
}

/**
 * The document, re-indented. Input that cannot be walked is returned unchanged.
 */
export function formatXml(source: string): string {
	const tokens = tokenize(source);
	if (!tokens) return source;
	const partner = pairTags(tokens);
	if (!partner) return source;

	const lines: string[] = [];
	let depth = 0;
	let i = 0;

	const push = (text: string) => lines.push(INDENT.repeat(depth) + text);

	while (i < tokens.length) {
		const token = tokens[i];
		const raw = source.slice(token.start, token.end);

		if (token.kind === "text") {
			// Whitespace between tags is the indentation being replaced. Text with
			// content in it is a value, and keeps its own leading/trailing spaces
			// off but nothing else.
			const trimmed = raw.trim();
			if (trimmed !== "") push(trimmed);
			i += 1;
			continue;
		}

		if (token.kind === "leaf") {
			push(raw);
			i += 1;
			continue;
		}

		if (token.kind === "close") {
			depth = Math.max(0, depth - 1);
			push(raw);
			i += 1;
			continue;
		}

		const closeIndex = partner.get(i)!;

		// `<a>text</a>` stays on one line: the line break an indenter would add
		// between a tag and its only text child is whitespace the document did not
		// have, and for a leaf value it is also simply harder to read.
		const onlyChild = closeIndex === i + 2 && tokens[i + 1].kind === "text";
		if (onlyChild) {
			const value = source.slice(tokens[i + 1].start, tokens[i + 1].end).trim();
			push(raw + value + source.slice(tokens[closeIndex].start, tokens[closeIndex].end));
			i = closeIndex + 1;
			continue;
		}

		// An empty element written as a pair (`<a></a>`) is the same case with no
		// text token between them.
		if (closeIndex === i + 1) {
			push(raw + source.slice(tokens[closeIndex].start, tokens[closeIndex].end));
			i = closeIndex + 1;
			continue;
		}

		if (isMixed(tokens, source, i, closeIndex, partner)) {
			push(source.slice(token.start, tokens[closeIndex].end));
			i = closeIndex + 1;
			continue;
		}

		push(raw);
		depth += 1;
		i += 1;
	}

	return lines.join("\n");
}
