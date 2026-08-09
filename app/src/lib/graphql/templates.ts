/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `{{variable}}` tokens inside GraphQL text, for the two readers that have to
 * cope with them: the diagnostics pass and the envelope serializer.
 *
 * The engine resolves `{{name}}` anywhere in a body before it goes on the wire,
 * so both a query and a variables object may legitimately hold tokens that are
 * *not* valid GraphQL and *not* valid JSON at rest. Two different maskings fall
 * out of that, and they are deliberately not the same function:
 *
 * - **GraphQL text** is masked in place, character for character, because the
 *   markers that come back carry positions into the masked string and those
 *   positions are only usable if they are also positions into the original.
 * - **JSON text** is masked into a *sentinel string*, which changes the length,
 *   because there is no length-preserving JSON value for `{{n}}` in every
 *   position - and nothing downstream needs offsets, only the parsed value.
 *
 * Both take their token syntax from `@/constants/variables`, the app's single
 * `{{name}}` matcher; neither re-declares it.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";

/** A 1-based Monaco-shaped range, the same shape `GqlMarker` uses. */
export interface TemplateSpan {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

/**
 * A GraphQL Name, repeated to the token's exact length.
 *
 * `V` rather than a keyword because a Name is the one lexeme that is grammatical
 * in every position a token realistically appears in - a field in a selection
 * set, an enum value in an argument, a fragment of an identifier - and because
 * `null` / `true` / `false` are excluded from EnumValue by the spec. The
 * shortest possible token is `{{a}}`, five characters, so the placeholder is
 * never so short that it fails the "starts with a letter" rule.
 */
const PLACEHOLDER_CHAR = "V";

/**
 * Replace every `{{token}}` with an identical-length GraphQL Name, and report
 * where they were.
 *
 * The point is that the document *parses*: an unmasked token is a syntax error
 * that aborts the parse, so one mid-edit variable costs the whole document its
 * validation. Masking keeps the rest of the document checked; the spans let the
 * caller drop the markers the placeholder itself provokes (a Name where an `Int`
 * was expected is still wrong, just wrong about something the user did not type).
 */
export function maskGraphqlTemplates(text: string): { masked: string; spans: TemplateSpan[] } {
	const spans: TemplateSpan[] = [];
	const masked = text.replace(VARIABLE_PATTERN, (match, _name: string, offset: number) => {
		const start = positionAt(text, offset);
		const end = positionAt(text, offset + match.length);
		spans.push({
			startLineNumber: start.line,
			startColumn: start.column,
			endLineNumber: end.line,
			endColumn: end.column,
		});
		return PLACEHOLDER_CHAR.repeat(match.length);
	});
	return { masked, spans };
}

/** 1-based line/column of a character offset, Monaco's convention. */
function positionAt(text: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}

/** True when the two 1-based ranges share at least one character. */
export function rangesOverlap(a: TemplateSpan, b: TemplateSpan): boolean {
	return before(a.startLineNumber, a.startColumn, b.endLineNumber, b.endColumn)
		? before(b.startLineNumber, b.startColumn, a.endLineNumber, a.endColumn)
		: false;
}

function before(lineA: number, colA: number, lineB: number, colB: number): boolean {
	return lineA === lineB ? colA < colB : lineA < lineB;
}

/**
 * The stand-in a `{{token}}` becomes inside JSON.
 *
 * NUL-delimited because JSON.stringify escapes NUL to the six characters
 * `\\u0000`, so the needle `unmaskJsonTemplates` looks for cannot be produced by
 * any character a user can type into an editor - a token is put back exactly
 * where the masker put one, and nowhere else.
 */
const sentinel = (index: number) => `\u0000vayu:tpl:${index}\u0000`;

const SENTINEL_MARK = "\u0000vayu:tpl:";

export interface MaskedJson {
	/** The text with every out-of-string token replaced by a JSON string. */
	masked: string;
	/** The original token text, indexed as the sentinels are numbered. */
	tokens: string[];
}

/**
 * Replace `{{token}}`s that sit where a JSON *value* would go with a placeholder
 * string, so the text parses.
 *
 * Tokens already inside a JSON string (`{"id": "{{userId}}"}`) are left alone:
 * that text is valid JSON as it stands, and wrapping it again would break it.
 * The scan tracks string state for exactly that reason - a regex cannot.
 */
export function maskJsonTemplates(text: string): MaskedJson {
	const tokens: string[] = [];
	let out = "";
	let inString = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") {
				out += text.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			out += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "{" && text[i + 1] === "{") {
			const close = text.indexOf("}}", i + 2);
			const inner = close === -1 ? "" : text.slice(i + 2, close);
			if (close !== -1 && inner.length > 0 && !/[{}]/.test(inner)) {
				out += JSON.stringify(sentinel(tokens.length));
				tokens.push(text.slice(i, close + 2));
				i = close + 2;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return { masked: out, tokens };
}

/** Put the original `{{token}}` text back into serialized JSON. */
export function unmaskJsonTemplates(json: string, tokens: string[]): string {
	let out = json;
	for (let i = 0; i < tokens.length; i++) {
		out = out.split(JSON.stringify(sentinel(i))).join(tokens[i]);
	}
	return out;
}

/** True when serialized JSON still carries a placeholder nobody unmasked. */
export function hasJsonTemplateSentinel(json: string): boolean {
	return json.includes(JSON.stringify(SENTINEL_MARK).slice(1, -1));
}
