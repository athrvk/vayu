/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import { isBlankRow } from "@/components/shared/KeyValueEditor/key-value";
import {
	isPathRow,
	maskTokens,
	pathRowsFromUrl,
	pathRowsOf,
	queryRowsOf,
	syncPathRows,
} from "./path-variables";
import { encodeQueryComponent, splitFragment } from "./query-encoding";

/** Whether a query built from rows percent-encodes them - see `writeQueryRow`. */
export interface UrlEncodeOptions {
	encode?: boolean;
}

/** One `key=value` pair of a URL's query, split as Postman's `QueryParam.parse` does. */
interface RawQueryPair {
	key: string;
	value: string;
	/** The pair has no `=` at all (`?flag`, not `?flag=`). */
	valueless: boolean;
	/** The pair exactly as the URL spells it. */
	text: string;
}

/** A URL cut at its query: `base` before the `?`, `query` up to the `#`, `fragment` from it. */
interface UrlQuerySplit {
	base: string;
	/** The query text, without its `?`; null when the URL has no `?`. */
	query: string | null;
	/** From the `#` on, or "" when there is none. */
	fragment: string;
}

/**
 * The URL cut at its fragment (first `#`), then its query (first `?` before that), a `{{variable}}`
 * token opaque so `{{a#b}}` is no fragment: the cut `pathVariableSegments` and the engine's
 * `path_variable_segments` make. The fragment is never sent, so a pair left glued to it would never
 * reach the server.
 */
function splitQuery(url: string): UrlQuerySplit {
	const { base: beforeFragment, fragment } = splitFragment(url);
	const queryStart = maskTokens(beforeFragment).indexOf("?");
	if (queryStart === -1) return { base: beforeFragment, query: null, fragment };
	return {
		base: beforeFragment.slice(0, queryStart),
		query: beforeFragment.slice(queryStart + 1),
		fragment,
	};
}

/**
 * The URL's query pairs, never decoded: split on `&`, then the first `=`; empty pairs (`a=1&&b=2`)
 * dropped.
 */
function rawQueryPairs(url: string): RawQueryPair[] {
	const { query } = splitQuery(url);
	if (query === null) return [];
	return query
		.split("&")
		.filter(Boolean)
		.map((text) => {
			const separator = text.indexOf("=");
			return separator === -1
				? { key: text, value: "", valueless: true, text }
				: {
						key: text.slice(0, separator),
						value: text.slice(separator + 1),
						valueless: false,
						text,
					};
		});
}

/**
 * The rows a query is written from: enabled and keyed, never a path row (`in: "path"`, #1764),
 * whose value fills a `:name` segment the URL already carries.
 */
function queryRowsToWrite(params: readonly KeyValueEntry[]): KeyValueEntry[] {
	return params.filter((p) => p.enabled && p.key.trim() && !isPathRow(p));
}

/** Whether @p row writes as a bare `key`: it is `valueless` and still has no value. */
export function writesBareKey(row: KeyValueEntry): boolean {
	return row.valueless === true && !row.value;
}

/**
 * One row as `key=value`, by Postman's query rule (`encodeQueryComponent`, #1771), or as typed
 * under `encode: false`, a request's `disableUrlEncoding` (#1765), so `q=a|b` stays `a|b` on the
 * wire. An empty value writes `key=` and a `valueless` row a bare `key`, as
 * `QueryParam.unparseSingle` writes `""` and `null` (#1772).
 */
function writeQueryRow(row: KeyValueEntry, encode: boolean): string {
	const key = encode ? encodeQueryComponent(row.key, "key") : row.key;
	if (writesBareKey(row)) return key;
	return `${key}=${encode ? encodeQueryComponent(row.value, "value") : row.value}`;
}

/**
 * The URL expressing exactly these params: the rows *replace* the URL's query; a fragment stays
 * after it. The Params table's rule only: there the rows are the whole query, so deleting the last
 * clears it.
 *
 * A row the URL already carries keeps the URL's bytes (#1771), so an edit rewrites only the pairs
 * it touches and a pair written by another rule survives (an Insomnia or OpenAPI import's
 * `encodeURIComponent` join, a Postman `key=`). Each enabled row takes the first unused pair
 * spelled exactly as it, and only then a pair that `safeDecode`s to it. That second match is for a
 * row an older version stored decoded (`+05:00` for `%2B05%3A00`; re-encoding sends a `+` a server
 * reads as a space), so only a row carried over unchanged from `previous` (same id, key and value)
 * gets it: a row just edited or added means what it says, so `+` typed over `%2B` is a `+`. With no
 * `previous`, every row counts as carried over. A row with no pair is encoded. The exact match also
 * requires the same `=`, so a row made valueless (or given its `=` back) is rewritten; the decoded
 * match does not, so a row from before valueless rows, holding `""` for a bare `?flag`, keeps it.
 */
export function buildUrlWithParams(
	baseUrl: string,
	params: readonly KeyValueEntry[],
	{ encode = true }: UrlEncodeOptions = {},
	previous?: readonly KeyValueItem[]
): string {
	const { base, fragment } = splitQuery(baseUrl);
	const pairs = rawQueryPairs(baseUrl);
	const used = new Array<boolean>(pairs.length).fill(false);
	const rows = queryRowsToWrite(params);
	const claim = (matches: (pair: RawQueryPair) => boolean): string | undefined => {
		const match = pairs.findIndex((pair, i) => !used[i] && matches(pair));
		if (match === -1) return undefined;
		used[match] = true;
		return pairs[match].text;
	};
	const carriedOver = (row: KeyValueEntry): boolean =>
		previous === undefined ||
		("id" in row &&
			previous.some(
				(p) =>
					p.id === row.id &&
					p.key === row.key &&
					p.value === row.value &&
					writesBareKey(p) === writesBareKey(row)
			));

	const written = rows.map((row) =>
		claim(
			(pair) =>
				pair.key === row.key &&
				pair.value === row.value &&
				pair.valueless === writesBareKey(row)
		)
	);
	rows.forEach((row, i) => {
		if (written[i] !== undefined || !carriedOver(row)) return;
		written[i] = claim(
			(pair) => safeDecode(pair.key) === row.key && safeDecode(pair.value) === row.value
		);
	});
	const query = rows.map((row, i) => written[i] ?? writeQueryRow(row, encode)).join("&");
	return `${query ? `${base}?${query}` : base}${fragment}`;
}

/**
 * The URL's query as items, never decoded: a row holds the query as the URL spells it (`a%20b`),
 * Postman's row model (`QueryParam.parse`) and the read side of `buildUrlWithParams`. Nothing is
 * lost (#1771): decoding is not reversible (`%2B` becomes a `+` a server reads as a space, `%2541`
 * becomes `%41`, a `%26` in a value a new pair), and the query encoding never encodes `%`, so a raw
 * row written back is its pair. A pair with no `=` (`?flag`) is a `valueless` row, written back
 * without.
 */
export function parseQueryParams(url: string): KeyValueItem[] {
	return rawQueryPairs(url).map(({ key, value, valueless }) => ({
		id: generateId(),
		key,
		value,
		enabled: true,
		...(valueless && { valueless: true as const }),
	}));
}

/**
 * The params rows a URL states alone, for a request arriving with a URL and no rows: its query,
 * then an empty path row per `:name` segment (#1764).
 */
export function paramsFromUrl(url: string): KeyValueItem[] {
	return [...parseQueryParams(url), ...pathRowsFromUrl(url)];
}

/**
 * The URL's query merged into the existing rows, not replacing them. A disabled row is invisible in
 * the URL (`buildUrlWithParams` skips it), so replacing with `parseQueryParams(url)` would delete
 * every disabled row on the next keystroke, and typing the query away would leave the enabled rows
 * it had (#1482). Enabled rows follow the URL's pair order and keep id, description and `source`; a
 * key the URL drops is dropped, a new key gets a fresh row where it stands. Following the URL keeps
 * the table's own rebuild (`buildUrlWithParams`, row order) from reordering the URL on the next
 * table edit (#3426).
 *
 * A row the URL cannot carry keeps its slot after the enabled row before it
 * (`unwrittenRowsByAnchor`): a disabled row, or one with a value and no key yet, which
 * `buildUrlWithParams` never writes either. Read as "dropped from the URL", a half-typed row was
 * deleted by the next URL keystroke and by every save's echo (#3663). The blank spare row is the
 * table's, not the URL's, and is left out. Path rows (#1764) follow the `:name` segments by
 * `syncPathRows`, which reads `previousUrl` to tell an edit of them from one that leaves them, and
 * come after the query rows.
 */
export function mergeParamsFromUrl(
	existing: readonly KeyValueItem[],
	url: string,
	previousUrl: string
): KeyValueItem[] {
	const fromUrl = parseQueryParams(url);
	const queryRows = queryRowsOf(existing);
	const claimedBy = claimUrlPairs(queryRows, fromUrl);
	const keptAfter = unwrittenRowsByAnchor(queryRows, new Set(claimedBy));

	const merged: KeyValueItem[] = [...(keptAfter.get(null) ?? [])];
	fromUrl.forEach((pair, i) => {
		const row = claimedBy[i];
		if (!row) {
			merged.push(pair);
			return;
		}
		const { valueless: _was, ...rest } = row;
		const { value, valueless } = pair;
		merged.push(
			{ ...rest, value, ...(valueless && { valueless }) },
			...(keptAfter.get(row) ?? [])
		);
	});

	return [...merged, ...syncPathRows(pathRowsOf(existing), url, previousUrl)];
}

/**
 * For each URL pair, the enabled row carrying it (the first unclaimed pair with the row's key, rows
 * in order), or `undefined` for a pair no row carries.
 */
function claimUrlPairs(
	rows: readonly KeyValueItem[],
	fromUrl: readonly KeyValueItem[]
): (KeyValueItem | undefined)[] {
	const claimedBy = new Array<KeyValueItem | undefined>(fromUrl.length).fill(undefined);
	for (const row of rows) {
		if (!row.enabled) continue;
		const i = fromUrl.findIndex((pair, at) => !claimedBy[at] && pair.key === row.key);
		if (i !== -1) claimedBy[i] = row;
	}
	return claimedBy;
}

/**
 * Each row the URL cannot carry (`isUnwrittenRow`), grouped under the nearest earlier row it still
 * carries (`null` when none, so it leads). A row the URL dropped anchors nothing, so what followed
 * it falls back to the row before. Order within a group is the existing order.
 */
function unwrittenRowsByAnchor(
	rows: readonly KeyValueItem[],
	surviving: ReadonlySet<KeyValueItem | undefined>
): Map<KeyValueItem | null, KeyValueItem[]> {
	const groups = new Map<KeyValueItem | null, KeyValueItem[]>();
	let anchor: KeyValueItem | null = null;
	for (const row of rows) {
		if (surviving.has(row)) {
			anchor = row;
			continue;
		}
		if (!isUnwrittenRow(row)) continue;
		groups.set(anchor, [...(groups.get(anchor) ?? []), row]);
	}
	return groups;
}

/**
 * A row `buildUrlWithParams` leaves out of the query (`queryRowsToWrite`), so the URL says nothing
 * of it: disabled, or holding something with no key.
 */
function isUnwrittenRow(row: KeyValueItem): boolean {
	return !row.enabled || (!row.key.trim() && !isBlankRow(row));
}

/** decodeURIComponent that leaves `{{var}}` tokens (and malformed input) untouched. */
export function safeDecode(part: string): string {
	if (part.includes("{{")) return part;
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

/**
 * A pasted URL with each line break and the whitespace around it removed, as an address bar treats
 * a URL wrapped by a terminal, a mail or a PDF (#3688). Other whitespace is the user's and stays;
 * the engine reports a URL with a space. Split rather than one `\s*[\r\n]\s*` regex, which is
 * quadratic on a long run of blanks with no break after it.
 */
export function joinWrappedLines(text: string): string {
	const lines = text.split(/[\r\n]+/);
	const last = lines.length - 1;
	return lines
		.map((line, i) => {
			const afterBreak = i > 0 ? line.trimStart() : line;
			return i < last ? afterBreak.trimEnd() : afterBreak;
		})
		.join("");
}
