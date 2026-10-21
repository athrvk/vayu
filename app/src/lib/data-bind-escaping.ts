/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How a bound row's cell is written into the field it lands in (issue #2639):
 * the engine's `FieldSplitter` / `TemplateJoiner` (`engine/src/core/
 * scenario_data.cpp`) and its leaf escapers (`vayu/utils/text_escape.hpp`),
 * restated for the Send-with-row preview and pinned to them by
 * `engine/tests/fixtures/data-bind-escaping-conformance.json`.
 *
 * A token's encoding is decided by the *literal* text before it, never by a
 * bound value: a value escaped for its placement cannot move the scan, so the
 * state after a token is the state before it. The JSON scan's escape flag
 * resets at each chunk while the XML scan's half-read delimiter carries across
 * one; both are the engine's exact chunk-wise behaviour.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import {
	advanceUrlComponent,
	encodeAtUrlComponent,
	encodeUrlAsPostman,
	type UrlComponent,
} from "@/modules/request-builder/utils/query-encoding";

/**
 * What kind of text a field is, the engine's `FieldContext`. `url` is a URL
 * sent encoded (one with `disableUrlEncoding` is `plain`); `header` is a header
 * name or value; `json` and `xml` are bodies whose mode makes them documents.
 */
export type DataFieldContext = "plain" | "url" | "header" | "json" | "xml";

/** Where a token sits, and so how its value is written: `DataValueEncoding`. */
type Placement =
	| "verbatim"
	| "url"
	| "jsonString"
	| "xmlText"
	| "xmlAttributeDouble"
	| "xmlAttributeSingle"
	| "xmlCdata"
	| "xmlComment"
	| "xmlProcessingInstruction";

/**
 * `text` as the inside of a JSON string literal: `escape_json_string_content`.
 * Only what JSON forbids raw is rewritten, so non-ASCII and `/` pass as typed
 * and a control character is `\u00xx` in lowercase hex.
 */
export function escapeJsonStringContent(text: string): string {
	let out = "";
	for (const char of text) {
		out += JSON_ESCAPES[char] ?? escapeControl(char);
	}
	return out;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '\\"',
	"\\": "\\\\",
	"\b": "\\b",
	"\f": "\\f",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};

function escapeControl(char: string): string {
	const code = char.charCodeAt(0);
	return code < 0x20 ? `\\u00${code.toString(16).padStart(2, "0")}` : char;
}

/**
 * `text` as XML content: `escape_xml_content`. `&`, `<` and `>` always, and
 * only the attribute delimiter in force (`null` in character data), so `it's`
 * stays readable inside a double-quoted attribute.
 */
export function escapeXmlContent(text: string, attributeQuote: '"' | "'" | null): string {
	let out = "";
	for (const char of text) {
		if (char === "&") out += "&amp;";
		else if (char === "<") out += "&lt;";
		else if (char === ">") out += "&gt;";
		else if (char === '"' && attributeQuote === '"') out += "&quot;";
		else if (char === "'" && attributeQuote === "'") out += "&apos;";
		else out += char;
	}
	return out;
}

/**
 * `text` inside a CDATA section: byte for byte, except that `]]>` closes the
 * section after its `]]` and reopens one for the `>`, so a parser reads one
 * uninterrupted run of the cell's text.
 */
export function escapeXmlCdata(text: string): string {
	return text.split("]]>").join("]]]]><![CDATA[>");
}

/** Whether `literal` leaves a JSON document inside a string literal. */
function advanceJsonStringState(literal: string, inString: boolean): boolean {
	let escaped = false;
	for (const char of literal) {
		if (escaped) {
			escaped = false;
		} else if (inString && char === "\\") {
			escaped = true;
		} else if (char === '"') {
			inString = !inString;
		}
	}
	return inString;
}

type XmlPosition =
	| "text"
	| "markup"
	| "attributeDouble"
	| "attributeSingle"
	| "cdata"
	| "comment"
	| "processingInstruction";

interface XmlScanState {
	position: XmlPosition;
	/** A delimiter matched so far and not yet resolved, carried across chunks. */
	pending: string;
}

/** The three things a `<` in character data can open; anything else is a tag. */
const XML_OPENERS: readonly { text: string; opens: XmlPosition }[] = [
	{ text: "<!--", opens: "comment" },
	{ text: "<![CDATA[", opens: "cdata" },
	{ text: "<?", opens: "processingInstruction" },
];

const XML_CLOSERS: Partial<Record<XmlPosition, string>> = {
	cdata: "]]>",
	comment: "-->",
	processingInstruction: "?>",
};

function xmlPositionAfterMarkupChar(char: string): XmlPosition {
	if (char === '"') return "attributeDouble";
	if (char === "'") return "attributeSingle";
	if (char === ">") return "text";
	return "markup";
}

/** The longest suffix of `candidate` that is a proper prefix of `pattern`. */
function longestPartialMatch(candidate: string, pattern: string): string {
	for (let length = Math.min(candidate.length, pattern.length - 1); length > 0; length--) {
		const suffix = candidate.slice(candidate.length - length);
		if (pattern.startsWith(suffix)) return suffix;
	}
	return "";
}

function advanceXmlText(char: string, state: XmlScanState): void {
	if (state.pending === "") {
		if (char === "<") state.pending = "<";
		return;
	}
	state.pending += char;
	const opened = XML_OPENERS.find((opener) => opener.text === state.pending);
	if (opened) {
		state.position = opened.opens;
		state.pending = "";
		return;
	}
	if (XML_OPENERS.some((opener) => opener.text.startsWith(state.pending))) return;
	// A tag after all, and the character that settled it is part of the tag.
	state.pending = "";
	state.position = xmlPositionAfterMarkupChar(char);
}

function advanceXmlCloser(char: string, closer: string, state: XmlScanState): void {
	const candidate = state.pending + char;
	if (candidate === closer) {
		state.position = "text";
		state.pending = "";
		return;
	}
	state.pending = longestPartialMatch(candidate, closer);
}

function advanceXmlState(literal: string, state: XmlScanState): void {
	for (const char of literal) {
		const closer = XML_CLOSERS[state.position];
		if (closer) {
			advanceXmlCloser(char, closer, state);
		} else if (state.position === "attributeDouble") {
			if (char === '"') state.position = "markup";
		} else if (state.position === "attributeSingle") {
			if (char === "'") state.position = "markup";
		} else if (state.position === "markup") {
			state.position = xmlPositionAfterMarkupChar(char);
		} else {
			advanceXmlText(char, state);
		}
	}
}

/** A tag or attribute name has no escape, so a token there is written as it is. */
const XML_PLACEMENTS: Record<XmlPosition, Placement> = {
	text: "xmlText",
	markup: "verbatim",
	attributeDouble: "xmlAttributeDouble",
	attributeSingle: "xmlAttributeSingle",
	cdata: "xmlCdata",
	comment: "xmlComment",
	processingInstruction: "xmlProcessingInstruction",
};

/** One placement per token, each read from the literal chunks before it only. */
function placementsOf(literals: readonly string[], context: DataFieldContext): Placement[] {
	const tokens = literals.slice(0, -1);
	if (context === "url") return tokens.map(() => "url");
	if (context === "json") {
		let inString = false;
		return tokens.map((literal) => {
			inString = advanceJsonStringState(literal, inString);
			return inString ? "jsonString" : "verbatim";
		});
	}
	if (context === "xml") {
		const state: XmlScanState = { position: "text", pending: "" };
		return tokens.map((literal) => {
			advanceXmlState(literal, state);
			return XML_PLACEMENTS[state.position];
		});
	}
	return tokens.map(() => "verbatim");
}

function encodeForPlacement(text: string, placement: Placement): string {
	switch (placement) {
		case "jsonString":
			return escapeJsonStringContent(text);
		case "xmlText":
			return escapeXmlContent(text, null);
		case "xmlAttributeDouble":
			return escapeXmlContent(text, '"');
		case "xmlAttributeSingle":
			return escapeXmlContent(text, "'");
		case "xmlCdata":
			return escapeXmlCdata(text);
		default:
			return text;
	}
}

/**
 * The subject a Send-with-row's refusal names: `POST /execute` binds its one
 * row as row 0 (`execution.cpp`), whichever row of the file was picked.
 */
const SEND_ROW_SUBJECT = "data row 0";

/** `describe_unwritable_placement`, word for word. */
function describeUnwritablePlacement(name: string, placement: Placement): string | null {
	if (placement === "xmlComment") {
		return (
			`{{${name}}} sits inside an XML comment, where a bound value is not sent at all - ` +
			'and one carrying "-->" would end the comment and change the document instead, so the ' +
			"row is refused rather than bound somewhere it cannot be read"
		);
	}
	if (placement === "xmlProcessingInstruction") {
		return (
			`{{${name}}} sits inside an XML processing instruction, which is markup addressed to the ` +
			'parser rather than content - a bound value carrying "?>" would end it and change the ' +
			"document, so the row is refused rather than bound into markup"
		);
	}
	return null;
}

/** `describe_header_line_break`, word for word. */
function describeHeaderLineBreak(name: string): string {
	return (
		`{{${name}}} is bound into a header, and ${SEND_ROW_SUBJECT} has a line break in that ` +
		"column - a CR or LF ends the header line rather than sitting in it, so the rest of the " +
		"value would be read as headers of its own; the row is refused rather than sent forging a header"
	);
}

/**
 * A field after a row is bound into it. `refusals` holds the engine's words for
 * each token the send would refuse the row over; such a token stays written as
 * it stands in `text`.
 */
export interface BoundField {
	text: string;
	refusals: string[];
}

/** A field split around the tokens a bind answers, the engine's `split_tokens`. */
interface TokenSplit {
	literals: string[];
	/** Trimmed, as the engine names them. */
	names: string[];
	/** As written, for a token the preview leaves in place. */
	written: string[];
}

function splitTokens(field: string, binds: (name: string) => boolean): TokenSplit {
	const split: TokenSplit = { literals: [], names: [], written: [] };
	let literal = "";
	let last = 0;
	for (const match of field.matchAll(VARIABLE_PATTERN)) {
		const name = match[1].trim();
		literal += field.slice(last, match.index);
		last = match.index + match[0].length;
		if (!binds(name)) {
			literal += match[0];
			continue;
		}
		split.literals.push(literal);
		split.names.push(name);
		split.written.push(match[0]);
		literal = "";
	}
	split.literals.push(literal + field.slice(last));
	return split;
}

/** One token's text: its encoded cell, or the token itself with the reason. */
function writeToken(
	name: string,
	cell: string | undefined,
	placement: Placement,
	context: DataFieldContext
): { text: string | null; refusal: string | null } {
	const unwritable = describeUnwritablePlacement(name, placement);
	if (unwritable) return { text: null, refusal: unwritable };
	if (cell === undefined) return { text: null, refusal: null };
	const encoded = encodeForPlacement(cell, placement);
	if (context === "header" && /[\r\n]/.test(encoded)) {
		return { text: null, refusal: describeHeaderLineBreak(name) };
	}
	return { text: encoded, refusal: null };
}

/**
 * `field` with every token `binds` accepts written as its cell (`cellOf`) is
 * encoded for the place it sits in - `TemplateJoiner`. A token `cellOf` has no
 * answer for, or one the send would refuse the row over, stays written as it
 * stands. Text a cell substitutes is never rescanned. A URL is written whole by
 * `encodeUrlAsPostman` afterwards, as the join ends one.
 */
export function bindDataTokens(
	field: string,
	binds: (name: string) => boolean,
	cellOf: (name: string) => string | undefined,
	context: DataFieldContext
): BoundField {
	const split = splitTokens(field, binds);
	if (split.names.length === 0) return { text: field, refusals: [] };
	const placements = placementsOf(split.literals, context);
	const refusals: string[] = [];
	let out = split.literals[0];
	let where: UrlComponent = advanceUrlComponent(split.literals[0], "head");
	split.names.forEach((name, i) => {
		const written = writeToken(name, cellOf(name), placements[i], context);
		if (written.refusal) refusals.push(written.refusal);
		const text = written.text ?? split.written[i];
		if (context === "url") {
			const atComponent = encodeAtUrlComponent(text, where);
			out += atComponent.written;
			where = advanceUrlComponent(split.literals[i + 1], atComponent.where);
		} else {
			out += text;
		}
		out += split.literals[i + 1];
	});
	return { text: context === "url" ? encodeUrlAsPostman(out) : out, refusals };
}
