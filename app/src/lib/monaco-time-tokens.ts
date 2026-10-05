/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the times are in a Monaco model (issue #1786): the spans the editor
 * token layer underlines and answers with the time card on hover.
 *
 * A pattern only finds candidates; `parseTimeValue` decides. The patterns are
 * deliberately loose about the shape (an `Feb 31`, an epoch outside the window)
 * so there is one definition of "is a time", and it is the parser's.
 *
 * Two readings, picked by language:
 *
 *  - **Code** (`json`, `javascript`, `graphql`): a string literal whose whole
 *    content is a time, or a bare epoch number. `"deadline 2026-10-05"` is a
 *    sentence that mentions a date, not a time value, and stays plain.
 *  - **Prose** (`plaintext`, `yaml`, `xml`, `html`, `http`): a time-shaped
 *    run anywhere, quoted or not - a YAML scalar, an element's text, a log
 *    line, a `Date:` or `Set-Cookie: ...; Expires=` header in the Raw tab.
 *    Quotes are not paired here: an apostrophe in prose (`it's`) would pair
 *    with the next one and swallow the time between them, and a time inside
 *    quotes is found by the same run anyway.
 */

import { parseTimeValue, type ParsedTime } from "./time-value";
import { HTTP_LANGUAGE_ID } from "./http-language";
import type { ScannableModel } from "./monaco-variable-tokens";

/** One time found in a model, in Monaco's 1-based line/column space. */
export interface TimeTokenRange {
	lineNumber: number;
	/** 1-based column of the first character of the time, inside any quotes. */
	startColumn: number;
	/** 1-based column just past its last character. */
	endColumn: number;
	/** The time as written, without its quotes - the card's "Original" row. */
	text: string;
	parsed: ParsedTime;
}

/** A model's time-finder, for one Monaco `language`. */
export type TimeTokenMatcher = (model: ScannableModel) => TimeTokenRange[];

/** The class that underlines a time, declared in `index.css`. */
export const TIME_TOKEN_CLASS = "vayu-time-token";

/**
 * Ten or thirteen digits standing alone - `parseEpoch`'s two lengths. Not
 * after a word character, a dot or a minus, and not before a word character
 * or a fraction, so a sixteen-digit id, a decimal and a negative number are
 * never cut down to a ten-digit run that happens to parse.
 */
const EPOCH = String.raw`(?<![\w.-])\d{10}(?:\d{3})?(?!\w|\.\d)`;

/** A string literal in any of the three quotes, its content in groups 1-3. */
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|` + "`((?:[^`\\\\]|\\\\.)*)`";

/**
 * An ISO date, with an optional time and, only after a time, a zone. A zone
 * straight after a bare date (`2026-10-05-10`) is a near miss, not an offset.
 */
const ISO = String.raw`(?<![\w.-])\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?(?![\w:+-]|\.\d)`;

/** IMF-fixdate and RFC 850 (`Sun, 05 Oct 2026 …`, `Sunday, 05-Oct-26 …`). */
const HTTP_DATE = String.raw`(?<![A-Za-z])[A-Za-z]{3,9}, \d{2}[ -][A-Za-z]{3}[ -]\d{2,4} \d{2}:\d{2}:\d{2} GMT(?!\w)`;

/** asctime (`Sun Oct  5 07:23:00 2026`). */
const ASCTIME = String.raw`(?<![A-Za-z])[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}(?!\w)`;

const CODE_PATTERN = new RegExp(`${QUOTED}|${EPOCH}`, "g");
const PROSE_PATTERN = new RegExp(`${ISO}|${HTTP_DATE}|${ASCTIME}|${EPOCH}`, "g");

/**
 * The times on one line, one pass of @p pattern.
 *
 * A quoted match carries its content in a group and starts one column past
 * the opening quote; a bare match is its own text.
 */
function timesInLine(line: string, lineNumber: number, pattern: RegExp): TimeTokenRange[] {
	const ranges: TimeTokenRange[] = [];
	for (const match of line.matchAll(pattern)) {
		const quoted = match[1] ?? match[2] ?? match[3];
		const text = quoted ?? match[0];
		const parsed = parseTimeValue(text);
		if (!parsed) continue;
		const startColumn = match.index + (quoted === undefined ? 1 : 2);
		ranges.push({
			lineNumber,
			startColumn,
			endColumn: startColumn + text.length,
			text,
			parsed,
		});
	}
	return ranges;
}

/**
 * Every time in the model, line by line.
 *
 * @param maxLines Stop after this many lines, the same cap the variable scan
 * takes and for the same reason: nobody has scrolled to line fifty thousand of
 * a response body, and painting it costs the same as painting what they see.
 */
function timeTokenScanner(pattern: RegExp, maxLines = 5000): TimeTokenMatcher {
	return (model) => {
		const ranges: TimeTokenRange[] = [];
		const lineCount = Math.min(model.getLineCount(), maxLines);
		for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
			for (const range of timesInLine(
				model.getLineContent(lineNumber),
				lineNumber,
				pattern
			)) {
				ranges.push(range);
			}
		}
		return ranges;
	};
}

export const codeTimeTokenRanges = timeTokenScanner(CODE_PATTERN);
export const proseTimeTokenRanges = timeTokenScanner(PROSE_PATTERN);

/**
 * The times in one line of text by the prose reading, for a surface outside
 * Monaco that shows what the Raw tab shows (a header value), so the two find
 * the same runs. Columns are 1-based, as in a model.
 */
export function proseTimeRuns(text: string): TimeTokenRange[] {
	return timesInLine(text, 1, PROSE_PATTERN);
}

/**
 * Which languages are scanned for times, and how. A language absent here is
 * not scanned at all. Unlike `VARIABLE_TOKEN_MATCHERS`, this map is not gated
 * on the editor being editable: a response body is exactly where a time is
 * read.
 */
export const TIME_TOKEN_MATCHERS: Record<string, TimeTokenMatcher> = {
	json: codeTimeTokenRanges,
	javascript: codeTimeTokenRanges,
	graphql: codeTimeTokenRanges,
	plaintext: proseTimeTokenRanges,
	yaml: proseTimeTokenRanges,
	xml: proseTimeTokenRanges,
	html: proseTimeTokenRanges,
	[HTTP_LANGUAGE_ID]: proseTimeTokenRanges,
};
