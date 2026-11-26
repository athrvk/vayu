/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Splitting one `key<sep>value` line for the bulk editors. Headers (`Name: value`) and params
 * (`key=value`) cannot share one separator, as one line shows:
 *
 *     filter:status=open
 *
 * is a legal query parameter (JIRA, Elasticsearch and OData put colons in names), so `:` cannot
 * split params, and a header line often has no `=` (`Authorization: Bearer abc`), so `=` cannot be
 * the only separator. The shared rule is one level up:
 *
 *   **the separator is the earliest character the key is not allowed to contain**
 *
 * which differs only because the key alphabets do:
 *
 *   - a header name may contain neither `:` nor `=`, so whichever comes first splits;
 *   - a param name may contain `:` but never `=`, so `=` wins wherever it is, and `:` is consulted
 *     only without one, which lets a header block pasted into Params parse instead of vanishing.
 *
 * Tiers express that: try each tier in order, earliest match within a tier.
 */

/** One tier of candidate separators. The earliest occurrence in a tier wins. */
export type SeparatorTiers = readonly (readonly string[])[];

/** A header name may contain neither, so the first of either is the split. */
export const HEADER_SEPARATORS: SeparatorTiers = [[":", "="]];

/**
 * A param name may contain `:` but not `=`, so `=` outranks it; the second tier lets a pasted
 * `Name: value` line survive.
 */
export const PARAM_SEPARATORS: SeparatorTiers = [["="], [":"]];

export interface SplitOptions {
	/**
	 * Read a line without a separator as a valueless key. True for params, where `?page` is legal
	 * and `buildUrlWithParams` emits one for a valueless row; false for headers, where
	 * `justsometext` names no header, and inventing an empty one would add a row the user did not
	 * write.
	 */
	allowBareKey?: boolean;
}

/**
 * A leading `//`, a row's disabled marker in bulk-edit text (#1480), matched only at line start
 * (leading whitespace tolerated), never mid-line: a header value often holds `//`
 * (`Referer: https://example.com`).
 */
const DISABLED_MARKER = /^\s*\/\/ ?/;

/**
 * Strip a leading disabled marker: written as `// `, read with or without the space, so a
 * hand-typed `//key: value` disables too.
 */
export function stripDisabledMarker(line: string): { enabled: boolean; rest: string } {
	const match = line.match(DISABLED_MARKER);
	if (!match) return { enabled: true, rest: line };
	return { enabled: false, rest: line.slice(match[0].length) };
}

/**
 * One line as a key and value, or null if it names nothing. A line opening with its separator
 * (`: orphaned`, `=orphaned`) names no key, and an empty-key row can be neither identified nor
 * fixed; the empty-key check covers it, as `slice(0, 0)` is empty. Once a tier matches it stands: a
 * line whose `=` is at position 0 is malformed, not meant to split at its colon. Only the key is
 * trimmed (a padded name is never intended); a value's whitespace can matter (a signature, a padded
 * token), so only the one conventional space after the separator goes (`key: value`) and the rest
 * is kept verbatim (#1480).
 */
export function splitKeyValueLine(
	line: string,
	tiers: SeparatorTiers,
	{ allowBareKey = false }: SplitOptions = {}
): { key: string; value: string; valueless?: true } | null {
	for (const tier of tiers) {
		const positions = tier.map((sep) => line.indexOf(sep)).filter((i) => i !== -1);
		if (positions.length === 0) continue;

		const at = Math.min(...positions);
		const key = line.slice(0, at).trim();
		if (!key) return null;
		const rawValue = line.slice(at + 1);
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
		return { key, value };
	}

	if (!allowBareKey) return null;
	const key = line.trim();
	return key ? { key, value: "", valueless: true } : null;
}

type SplitLine = { key: string; value: string; valueless?: true };

/** One non-blank line of bulk-edit text, read the way the parsers read it. */
export interface ScannedLine {
	/** 1-based, counted over the original text, blank lines included. */
	lineNumber: number;
	text: string;
	enabled: boolean;
	/** Null when the line names no key: the parsers drop it. */
	parsed: SplitLine | null;
}

/** A line the parsers drop, for the notice that says so (#3694). */
export interface UnreadLine {
	lineNumber: number;
	text: string;
}

/**
 * Every non-blank line, disabled marker stripped, then split. The parsers and the unread-line
 * report both read through this, so what is reported is what is dropped. A blank line is no
 * intended row and is not scanned.
 */
export function scanKeyValueLines(
	text: string,
	tiers: SeparatorTiers,
	options?: SplitOptions
): ScannedLine[] {
	const scanned: ScannedLine[] = [];
	text.split("\n").forEach((line, index) => {
		if (!line.trim()) return;
		const { enabled, rest } = stripDisabledMarker(line);
		scanned.push({
			lineNumber: index + 1,
			text: line.trim(),
			enabled,
			parsed: splitKeyValueLine(rest, tiers, options),
		});
	});
	return scanned;
}

/** The scanned lines the parser drops. */
export function unreadLinesOf(scanned: readonly ScannedLine[]): UnreadLine[] {
	return scanned
		.filter((line) => !line.parsed)
		.map(({ lineNumber, text }) => ({ lineNumber, text }));
}
