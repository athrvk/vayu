/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Splitting one `key<sep>value` line, for the bulk editors.
 *
 * Headers and params looked like they had two arbitrary formats - `Name: value`
 * against `key=value` - and the obvious tidy-up is to pick one. They cannot
 * share one, and a single line shows why:
 *
 *     filter:status=open
 *
 * That is a legal query parameter: a param *name* may contain a colon (JIRA,
 * Elasticsearch and OData all do it), so `:` cannot be the separator or the line
 * splits as `filter` / `status=open`. Meanwhile a header line frequently has no
 * `=` at all - `Authorization: Bearer abc` - so `=` cannot be the only
 * separator either.
 *
 * The rule they *do* share is one level up:
 *
 *   **the separator is the earliest character the key is not allowed to contain**
 *
 * which resolves differently only because the two key alphabets differ:
 *
 *   - a header name may contain neither `:` nor `=`, so whichever comes first
 *     is the separator;
 *   - a param name may contain `:` but never `=`, so `=` wins wherever it
 *     appears, and `:` is consulted only when the line has no `=` - which is
 *     what makes a header block pasted into the Params tab parse instead of
 *     vanishing.
 *
 * Tiers express exactly that: try each tier in order, take the earliest match
 * within a tier.
 */

/** One tier of candidate separators. The earliest occurrence in a tier wins. */
export type SeparatorTiers = readonly (readonly string[])[];

/** A header name may contain neither, so the first of either is the split. */
export const HEADER_SEPARATORS: SeparatorTiers = [[":", "="]];

/**
 * A param name may contain `:` but not `=`, so `=` outranks it. The second tier
 * is what lets a pasted `Name: value` line survive.
 */
export const PARAM_SEPARATORS: SeparatorTiers = [["="], [":"]];

export interface SplitOptions {
	/**
	 * Treat a line with no separator as a key with an empty value.
	 *
	 * True for params, where `?page` is a legal valueless parameter and
	 * `buildUrlWithParams` already emits one. False for headers, where a bare
	 * word names no header - `justsometext` is not a header line, and inventing
	 * an empty one from it would put a row in the table the user did not write.
	 */
	allowBareKey?: boolean;
}

/**
 * Split one line into a key and a value, or return null if it names nothing.
 *
 * A line that opens with its separator - `: orphaned`, `=orphaned` - names no
 * key, and a row with an empty key is one the user can neither identify nor
 * fix. That is handled by the empty-key check rather than a separate guard on
 * the separator's position: an earlier draft had both, and a mutation run
 * showed the position check could be deleted with every test still green,
 * because `slice(0, 0)` is empty and the key check already rejects it.
 *
 * Once a tier matches, the result stands - it does not fall through to a later
 * tier. A line whose `=` is at position 0 is malformed, not a line that meant
 * to be split at its colon instead.
 */
export function splitKeyValueLine(
	line: string,
	tiers: SeparatorTiers,
	{ allowBareKey = false }: SplitOptions = {}
): { key: string; value: string } | null {
	for (const tier of tiers) {
		const positions = tier.map((sep) => line.indexOf(sep)).filter((i) => i !== -1);
		if (positions.length === 0) continue;

		const at = Math.min(...positions);
		const key = line.slice(0, at).trim();
		if (!key) return null;
		return { key, value: line.slice(at + 1).trim() };
	}

	if (!allowBareKey) return null;
	const key = line.trim();
	return key ? { key, value: "" } : null;
}
